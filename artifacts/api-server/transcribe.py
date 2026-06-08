#!/usr/bin/env python3
"""
Transcribe audio with faster-whisper (base model — better accuracy than tiny).
Usage: transcribe.py <audio_path>
Output: JSON { "text": "..." }
"""
import sys
import json

def transcribe(audio_path: str) -> str:
    from faster_whisper import WhisperModel
    model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        audio_path,
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=True,
        no_speech_threshold=0.4,
        compression_ratio_threshold=2.4,
    )
    texts = []
    for s in segments:
        t = s.text.strip()
        if t:
            texts.append(t)
    return " ".join(texts).strip()

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
