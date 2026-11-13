"""Self-check: load LiquidCodec, round-trip a clip, verify streaming parity.

Run with: uv run smoke.py
"""

import time
import wave

import numpy as np
import torch
from transformers import AutoModel
from transformers.dynamic_module_utils import get_class_from_dynamic_module

MODEL_ID = "LiquidAI/Liquid-Codec"
SR = 24000
FRAME = 1920


def main() -> None:
    with wave.open("static/sample.wav") as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    x = torch.from_numpy(audio)[None]
    duration = len(audio) / SR

    t0 = time.perf_counter()
    codec = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True, dtype=torch.float32).eval()
    print(f"model loaded in {time.perf_counter() - t0:.1f}s")

    with torch.inference_mode():
        t0 = time.perf_counter()
        codes = codec.encode(x).audio_codes
        encode_s = time.perf_counter() - t0
        t0 = time.perf_counter()
        rec = codec.decode(codes).audio_values
        decode_s = time.perf_counter() - t0

    assert codes.shape[0] == 1 and codes.shape[1] == 12, codes.shape
    assert codes.shape[-1] == -(-len(audio) // FRAME), codes.shape
    assert int(codes.min()) >= 0 and int(codes.max()) < codec.config.codebook_size
    assert rec.shape[-1] >= len(audio), rec.shape
    assert torch.isfinite(rec).all(), "decoder produced NaN/inf"
    print(f"{duration:.1f}s: {codes.shape[-1]} frames, {codes.numel()} tokens")
    print(f"encode {encode_s * 1000:.0f} ms ({duration / encode_s:.0f}x) · decode {decode_s * 1000:.0f} ms ({duration / decode_s:.0f}x)")

    cache_cls = get_class_from_dynamic_module("modeling_liquid_codec.LiquidCodecStreamingCache", MODEL_ID)
    with torch.inference_mode():
        cache = cache_cls(codec.config)
        chunks = [codec.decode(codes[..., i : i + 1], cache, finalize=False).audio_values for i in range(codes.shape[-1])]
        chunks.append(codec.decode(codes[..., :0], cache, finalize=True).audio_values)
        streamed = torch.cat(chunks, dim=-1)
    assert streamed.shape == rec.shape, (streamed.shape, rec.shape)
    diff = float((streamed - rec).abs().max())
    assert diff < 1e-3, f"streaming decode diverged: {diff}"
    print(f"streaming decode matches full decode (max diff {diff:.2e})")

    # The live path re-encodes the growing buffer and holds the last frame back.
    # Earlier frames must match the one-shot encode exactly.
    with torch.inference_mode():
        emitted = 0
        for end in range(FRAME * 5, len(audio) + FRAME, FRAME * 5):
            end = min(end, len(audio))
            prefix = codec.encode(x[..., :end]).audio_codes
            upto = max(emitted, prefix.shape[-1] - 1)
            assert torch.equal(prefix[..., emitted:upto], codes[..., emitted:upto]), f"token drift at {end}"
            emitted = upto
    print("streaming encode tokens match one-shot encode")
    print("ok")


if __name__ == "__main__":
    main()
