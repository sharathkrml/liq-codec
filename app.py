"""LiquidCodec Studio - local demo for LiquidAI/Liquid-Codec.

Encodes 24 kHz speech into 12 tokens every 80 ms, visualizes the tokens and
plays the reconstruction back. Also streams mic audio through the codec with
the incremental decoder, and lets LFM3-Audio answer a recording out loud.
"""

from __future__ import annotations

import asyncio
import base64
import io
import math
import subprocess
import tempfile
import threading
import time
import uuid
import wave
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from transformers import AutoModel
from transformers.dynamic_module_utils import get_class_from_dynamic_module

MODEL_ID = "LiquidAI/Liquid-Codec"
TALK_MODEL_ID = "LiquidAI/LFM3-Audio-2B-MLX-4bit"
TALK_SYSTEM = "Respond with interleaved text and audio."
TALK_MAX_TOKENS = 1024
SAMPLE_RATE = 24_000
FRAME_SAMPLES = 1_920  # 80 ms
N_CODEBOOKS = 12
MAX_SECONDS = 30
MAX_LIVE_SECONDS = 20
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
STATIC_DIR = Path(__file__).parent / "static"

state: dict = {}


def load_codec():
    codec = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True, dtype=torch.float32)
    codec.eval()
    cache_cls = get_class_from_dynamic_module("modeling_liquid_codec.LiquidCodecStreamingCache", MODEL_ID)
    return codec, cache_cls


@asynccontextmanager
async def lifespan(_app: FastAPI):
    print(f"loading {MODEL_ID} ...")
    t0 = time.perf_counter()
    state["codec"], state["cache_cls"] = await asyncio.to_thread(load_codec)
    state["lock"] = threading.Lock()
    state["talk_lock"] = threading.Lock()
    state["talk_state"] = "idle"
    state["talk_load_ms"] = 0
    state["talk_error"] = ""
    state["codebook_size"] = int(state["codec"].config.codebook_size)
    print(f"ready in {time.perf_counter() - t0:.1f}s")
    yield
    state.clear()


app = FastAPI(title="LiquidCodec Studio", lifespan=lifespan)


def ffmpeg_decode(data: bytes) -> np.ndarray:
    """Any container ffmpeg knows -> mono float32 at 24 kHz."""
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-i", "pipe:0",
                "-t", str(MAX_SECONDS + 2),
                "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-",
            ],
            input=data,
            capture_output=True,
        )
    except FileNotFoundError as exc:
        raise ValueError("ffmpeg is required but was not found on PATH.") from exc
    audio = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    if proc.returncode != 0 or audio.size == 0:
        raise ValueError("Could not decode that file. Try WAV, MP3, M4A, FLAC or OGG.")
    return audio


def wav_base64(audio: np.ndarray) -> str:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return base64.b64encode(buf.getvalue()).decode()


def pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def stats(duration: float, frames: int, encode_s: float, decode_s: float) -> dict:
    codebook_bits = math.log2(state["codebook_size"])
    return {
        "durationSec": round(duration, 2),
        "frames": frames,
        "tokens": frames * N_CODEBOOKS,
        "tokensPerSec": round(N_CODEBOOKS * SAMPLE_RATE / FRAME_SAMPLES, 1),
        "bitrateKbps": round(codebook_bits * N_CODEBOOKS * SAMPLE_RATE / FRAME_SAMPLES / 1000, 2),
        "encodeMs": round(encode_s * 1000),
        "decodeMs": round(decode_s * 1000),
        "encodeX": round(duration / encode_s) if encode_s else None,
        "decodeX": round(duration / decode_s) if decode_s else None,
        "codebookSize": state["codebook_size"],
    }


def roundtrip(audio: np.ndarray):
    x = torch.from_numpy(audio).unsqueeze(0)
    with state["lock"], torch.inference_mode():
        t0 = time.perf_counter()
        codes = state["codec"].encode(x).audio_codes
        encode_s = time.perf_counter() - t0
        t0 = time.perf_counter()
        rec = state["codec"].decode(codes).audio_values[0]
        decode_s = time.perf_counter() - t0
    return codes[0].numpy(), rec.numpy()[: len(audio)], encode_s, decode_s


def ensure_talk():
    """Load LFM3-Audio once. Concurrent callers wait here until it is ready."""
    with state["talk_lock"]:
        if "talk" in state:
            return
        state["talk_state"] = "loading"
        state["talk_error"] = ""
        t0 = time.perf_counter()
        try:
            from mlx_vlm import load

            state["talk"] = load(TALK_MODEL_ID)
        except Exception as exc:
            state["talk_state"] = "error"
            state["talk_error"] = str(exc)
            raise
        state["talk_load_ms"] = round((time.perf_counter() - t0) * 1000)
        state["talk_state"] = "ready"


def talk_snapshot() -> dict:
    return {
        "state": state.get("talk_state", "idle"),
        "model": TALK_MODEL_ID,
        "loadMs": state.get("talk_load_ms", 0),
        "error": state.get("talk_error", ""),
    }


def talk_reply(audio: np.ndarray) -> dict:
    """One turn: LFM3-Audio hears the clip and answers with text + speech."""
    from mlx_vlm.generate.audio import generate_audio
    from mlx_vlm.prompt_utils import apply_chat_template

    ensure_talk()
    with state["talk_lock"]:
        model, processor = state["talk"]

        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            path = Path(tmp.name)
        try:
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SAMPLE_RATE)
                w.writeframes(pcm.tobytes())
            t0 = time.perf_counter()
            prompt = apply_chat_template(
                processor,
                model.config,
                [{"role": "system", "content": TALK_SYSTEM}, ""],
                num_audios=1,
                use_tts_template=True,
            )
            result = generate_audio(
                model, processor, prompt, audio=[str(path)], max_tokens=TALK_MAX_TOKENS
            )
            generate_s = time.perf_counter() - t0
        finally:
            path.unlink(missing_ok=True)

    return {
        "model": TALK_MODEL_ID,
        "text": result.text,
        "replyWav": base64.b64encode(result.to_wav_bytes()).decode(),
        "sampleRate": result.sample_rate,
        "audioSec": round(result.audio.size / result.sample_rate, 2),
        "tokens": result.generation_tokens,
        "finishReason": result.finish_reason,
        "generateMs": round(generate_s * 1000),
    }


TTS_VOICES = ("female", "male")
TTS_MAX_CHARS = 1000


def tts_reply(text: str, voice: str) -> dict:
    """Speak `text` with the model's learned voice (no input audio)."""
    from mlx_vlm.generate.audio import generate_audio

    # ChatML tokens contain "<|" — dropping it stops the text from escaping the user turn
    safe_text = " ".join(text.split()).replace("<|", "<")

    ensure_talk()
    with state["talk_lock"]:
        model, processor = state["talk"]
        bos = processor.tokenizer.bos_token or "<|startoftext|>"
        prompt = (
            f"{bos}<|im_start|>system\n"
            f"Perform TTS in American English using a {voice} voice.<|im_end|>\n"
            f"<|im_start|>user\n{safe_text}<|im_end|>\n"
            f"<|im_start|>assistant\n<|audio_start|>"
        )
        t0 = time.perf_counter()
        result = generate_audio(model, processor, prompt, max_tokens=TALK_MAX_TOKENS)
        generate_s = time.perf_counter() - t0

    return {
        "model": TALK_MODEL_ID,
        "voice": voice,
        "replyWav": base64.b64encode(result.to_wav_bytes()).decode(),
        "sampleRate": result.sample_rate,
        "audioSec": round(result.audio.size / result.sample_rate, 2),
        "tokens": result.generation_tokens,
        "finishReason": result.finish_reason,
        "generateMs": round(generate_s * 1000),
    }


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health():
    return {"ok": "codec" in state, "model": MODEL_ID, "talkModel": TALK_MODEL_ID,
            "sampleRate": SAMPLE_RATE, "frameSamples": FRAME_SAMPLES, "codebooks": N_CODEBOOKS}


@app.post("/api/roundtrip")
async def api_roundtrip(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File is too large (max 50 MB).")
    try:
        audio = await asyncio.to_thread(ffmpeg_decode, data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    duration = len(audio) / SAMPLE_RATE
    if duration >= MAX_SECONDS:
        raise HTTPException(413, f"Clip is longer than {MAX_SECONDS}s - trim it first.")
    if duration < 0.2:
        raise HTTPException(400, "Clip is too short.")

    codes, rec, encode_s, decode_s = await asyncio.to_thread(roundtrip, audio)
    payload = {
        **stats(duration, codes.shape[-1], encode_s, decode_s),
        "codes": codes.T.tolist(),  # frames x codebooks
        "originalWav": wav_base64(audio),
        "reconstructedWav": wav_base64(rec),
    }
    return payload


@app.post("/api/talk")
async def api_talk(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File is too large (max 50 MB).")
    try:
        audio = await asyncio.to_thread(ffmpeg_decode, data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    duration = len(audio) / SAMPLE_RATE
    if duration >= MAX_SECONDS:
        raise HTTPException(413, f"Clip is longer than {MAX_SECONDS}s - keep it short.")
    if duration < 0.3:
        raise HTTPException(400, "Clip is too short to answer - hold the button and speak.")

    try:
        payload = await asyncio.to_thread(talk_reply, audio)
    except Exception as exc:  # model load or generation failure
        raise HTTPException(500, f"LFM3-Audio failed: {exc}") from exc
    payload["durationSec"] = round(duration, 2)
    return payload


@app.get("/api/talk/status")
def api_talk_status():
    return talk_snapshot()


@app.post("/api/talk/load")
async def api_talk_load():
    try:
        await asyncio.to_thread(ensure_talk)
    except Exception as exc:  # import, download or memory failure
        raise HTTPException(500, f"Could not load LFM3-Audio: {exc}") from exc
    return talk_snapshot()


@app.post("/api/tts")
async def api_tts(request: Request):
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON body.") from None
    if not isinstance(payload, dict):
        raise HTTPException(400, "Invalid JSON body.")

    text = payload.get("text", "")
    voice = payload.get("voice", "female")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(400, "Text must be a non-empty string.")
    if len(text) > TTS_MAX_CHARS:
        raise HTTPException(400, f"Text must be {TTS_MAX_CHARS} characters or fewer.")
    if voice not in TTS_VOICES:
        raise HTTPException(400, "Voice must be 'female' or 'male'.")

    try:
        return await asyncio.to_thread(tts_reply, text, voice)
    except Exception as exc:  # model load or generation failure
        raise HTTPException(500, f"LFM3-Audio failed: {exc}") from exc


class LiveSession:
    def __init__(self):
        self.id = uuid.uuid4().hex
        self.buffer = np.zeros(0, dtype=np.float32)
        self.cache = state["cache_cls"](state["codec"].config)
        self.emitted = 0
        self.encode_total = 0.0
        self.decode_total = 0.0
        self.limit_hit = False
        self.created = time.time()
        self.lock = threading.Lock()


LIVE_SESSIONS: dict[str, LiveSession] = {}
LIVE_SESSIONS_LOCK = threading.Lock()
LIVE_SESSION_TTL = 300


def prune_live_sessions():
    now = time.time()
    with LIVE_SESSIONS_LOCK:
        for sid, session in list(LIVE_SESSIONS.items()):
            if now - session.created > LIVE_SESSION_TTL:
                LIVE_SESSIONS.pop(sid, None)


def live_encode(session: LiveSession, hold_last: bool):
    """Encode the whole causal buffer and decode only frames not emitted yet."""
    x = torch.from_numpy(session.buffer).unsqueeze(0)
    with state["lock"], torch.inference_mode():
        t0 = time.perf_counter()
        codes = state["codec"].encode(x).audio_codes
        enc = time.perf_counter() - t0
        total = codes.shape[-1]
        upto = max(session.emitted, total - 1) if hold_last else total
        new = codes[..., session.emitted:upto]
        t0 = time.perf_counter()
        audio = state["codec"].decode(new, session.cache, finalize=False).audio_values[0].numpy() if new.numel() else np.zeros(0, dtype=np.float32)
        dec = time.perf_counter() - t0
    session.emitted = upto
    session.encode_total += enc
    session.decode_total += dec
    return new[0].T.tolist(), new.shape[-1], audio, enc, dec, total


def live_payload(session: LiveSession, kind: str, tokens, n_new: int, audio: np.ndarray, enc: float, dec: float, total: int) -> dict:
    return {
        "type": kind,
        "tokens": tokens,
        "newFrames": int(n_new),
        "emittedFrames": int(session.emitted),
        "totalFrames": int(total),
        "encodeMs": round(enc * 1000),
        "decodeMs": round(dec * 1000),
        "encodeTotalMs": round(session.encode_total * 1000),
        "decodeTotalMs": round(session.decode_total * 1000),
        "audio": base64.b64encode(pcm16(audio)).decode() if audio.size else "",
    }


@app.post("/api/live/start")
def live_start():
    if "codec" not in state:
        raise HTTPException(503, "Model is still loading.")
    prune_live_sessions()
    session = LiveSession()
    with LIVE_SESSIONS_LOCK:
        LIVE_SESSIONS[session.id] = session
    return {"sessionId": session.id, "sampleRate": SAMPLE_RATE, "maxSeconds": MAX_LIVE_SECONDS}


@app.post("/api/live/{sid}/chunk")
async def live_chunk(sid: str, request: Request):
    session = LIVE_SESSIONS.get(sid)
    if session is None:
        raise HTTPException(404, "Stream expired - start a new one.")
    body = await request.body()
    if not body or len(body) % 4:
        raise HTTPException(400, "Expected float32 PCM bytes.")
    if len(body) > 4 * 1024 * 1024:
        raise HTTPException(413, "Chunk is too large.")
    pcm = np.frombuffer(body, dtype="<f4").copy()

    def work():
        with session.lock:
            session.buffer = np.concatenate([session.buffer, pcm])
            if len(session.buffer) >= MAX_LIVE_SECONDS * SAMPLE_RATE:
                session.buffer = session.buffer[: MAX_LIVE_SECONDS * SAMPLE_RATE]
                session.limit_hit = True
                return live_payload(session, "limit", [], 0, np.zeros(0, np.float32), 0, 0, session.emitted)
            if len(session.buffer) < FRAME_SAMPLES:
                return live_payload(session, "chunk", [], 0, np.zeros(0, np.float32), 0, 0, 0)
            tokens, n_new, audio, enc, dec, total = live_encode(session, True)
            return live_payload(session, "chunk", tokens, n_new, audio, enc, dec, total)

    return await asyncio.to_thread(work)


@app.post("/api/live/{sid}/stop")
async def live_stop(sid: str):
    session = LIVE_SESSIONS.pop(sid, None)
    if session is None:
        return {
            "type": "done", "tokens": [], "newFrames": 0, "emittedFrames": 0,
            "totalFrames": 0, "encodeMs": 0, "decodeMs": 0,
            "encodeTotalMs": 0, "decodeTotalMs": 0, "audio": "",
        }

    def work():
        with session.lock:
            if not len(session.buffer):
                return live_payload(session, "done", [], 0, np.zeros(0, np.float32), 0, 0, 0)
            tokens, n_new, audio, enc, dec, total = live_encode(session, False)
            with state["lock"], torch.inference_mode():
                tail = state["codec"].decode(
                    torch.zeros(1, N_CODEBOOKS, 0, dtype=torch.long), session.cache, finalize=True
                ).audio_values[0].numpy()
            if tail.size:
                audio = np.concatenate([audio, tail])
            return live_payload(session, "done", tokens, n_new, audio[: len(session.buffer)], enc, dec, total)

    return await asyncio.to_thread(work)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
