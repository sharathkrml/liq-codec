"""Check a running server's /api/talk endpoint.

    uv run python talk_check.py [question.wav]

Defaults to static/sample.wav. Asserts the reply has text and a 24 kHz WAV.
The first call also loads LFM3-Audio, so allow ~30 s.
"""

import base64
import io
import sys
import wave

import requests

path = sys.argv[1] if len(sys.argv) > 1 else "static/sample.wav"
with open(path, "rb") as handle:
    response = requests.post(
        "http://127.0.0.1:8000/api/talk",
        files={"file": (path, handle, "audio/wav")},
        timeout=300,
    )
response.raise_for_status()
data = response.json()

assert data["text"].strip(), "empty reply text"
with wave.open(io.BytesIO(base64.b64decode(data["replyWav"]))) as wav:
    assert wav.getframerate() == 24000, wav.getframerate()
    assert wav.getnframes() > 24000 // 4, "reply is shorter than 0.25 s"

print(f"text: {data['text']}")
print(
    f"wav {data['audioSec']}s · {data['tokens']} tokens · "
    f"{data['finishReason']} · generate {data['generateMs']} ms"
)
