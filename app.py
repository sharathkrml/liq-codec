"""LiquidCodec Studio - talk to LFM3-Audio out loud.

Speak into the mic; LFM3-Audio-2B (4-bit MLX) hears the clip, answers in text,
and speaks back. Its speech tokens are LiquidCodec tokens, decoded to 24 kHz PCM.
Everything runs locally.
"""

from __future__ import annotations

import asyncio
import base64
import subprocess
import tempfile
import threading
import time
import wave
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

TALK_MODEL_ID = "LiquidAI/LFM3-Audio-2B-MLX-4bit"
TALK_SYSTEM = "Respond with interleaved text and audio."
TALK_MAX_TOKENS = 1024
SAMPLE_RATE = 24_000
MAX_SECONDS = 30
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
STATIC_DIR = Path(__file__).parent / "static"

state: dict = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    state["talk_lock"] = threading.Lock()
    state["talk_state"] = "idle"
    state["talk_load_ms"] = 0
    state["talk_error"] = ""
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


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health():
    return {"ok": True, "model": TALK_MODEL_ID, "sampleRate": SAMPLE_RATE}


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


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
