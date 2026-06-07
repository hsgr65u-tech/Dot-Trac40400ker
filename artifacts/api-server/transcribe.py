#!/usr/bin/env python3
"""
Transcribe audio with faster-whisper (tiny model, no API key needed).
Usage: transcribe.py <audio_path>
Output: JSON { "text": "..." }
"""
import sys
import json

def transcribe(audio_path: str) -> str:
    from faster_whisper import WhisperModel
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(audio_path, beam_size=5, vad_filter=True)
    return " ".join(s.text.strip() for s in segments).strip()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "audio path required"}))
        sys.exit(1)
    try:
        text = transcribe(sys.argv[1])
        print(json.dumps({"text": text}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
