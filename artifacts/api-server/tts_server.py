#!/usr/bin/env python3
"""
Persistent TTS server — handles both Edge TTS (Microsoft) and OpenAI.fm voices.
Keeps modules loaded between requests to avoid per-request startup overhead.
"""
import asyncio
import os
import tempfile
import uuid
import aiohttp
from aiohttp import web
import edge_tts

PORT = int(os.environ.get("TTS_SERVER_PORT", "19998"))

OPENAI_FM_URL = "https://www.openai.fm/api/generate"

OPENAI_FM_VOICES = {
    "alloy", "ash", "ballad", "coral", "echo",
    "fable", "nova", "onyx", "sage", "shimmer", "verse",
}


async def handle_synthesize(request: web.Request) -> web.Response:
    """Edge TTS synthesis (Microsoft voices like ar-SA-HamedNeural)."""
    try:
        data = await request.json()
        text = (data.get("text") or "").strip()
        voice = (data.get("voice") or "ar-SA-HamedNeural").strip()
        rate_str = (data.get("rate") or "+0%").strip()

        if not text:
            return web.json_response({"error": "النص فارغ"}, status=400)

        communicate = edge_tts.Communicate(text, voice, rate=rate_str)

        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            tmp_path = f.name

        try:
            await communicate.save(tmp_path)
            with open(tmp_path, "rb") as f:
                audio_data = f.read()
            return web.Response(
                body=audio_data,
                content_type="audio/mpeg",
                headers={"Content-Length": str(len(audio_data))},
            )
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_synthesize_openai(request: web.Request) -> web.Response:
    """OpenAI.fm TTS synthesis (GPT-4o mini voices: alloy, nova, echo, etc.)."""
    try:
        data = await request.json()
        text = (data.get("text") or "").strip()
        voice = (data.get("voice") or "alloy").strip().lower()

        if not text:
            return web.json_response({"error": "النص فارغ"}, status=400)

        if voice not in OPENAI_FM_VOICES:
            return web.json_response({"error": f"صوت غير معروف: {voice}"}, status=400)

        form_data = aiohttp.FormData()
        form_data.add_field("input", text)
        form_data.add_field("voice", voice)
        form_data.add_field("generation", str(uuid.uuid4()))
        form_data.add_field("response_format", "mp3")

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }

        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(OPENAI_FM_URL, data=form_data, headers=headers) as resp:
                if resp.status == 200:
                    audio_data = await resp.read()
                    return web.Response(
                        body=audio_data,
                        content_type="audio/mpeg",
                        headers={"Content-Length": str(len(audio_data))},
                    )
                else:
                    err_text = await resp.text()
                    return web.json_response(
                        {"error": f"openai.fm خطأ {resp.status}: {err_text[:200]}"},
                        status=502,
                    )
    except asyncio.TimeoutError:
        return web.json_response({"error": "انتهت مهلة openai.fm"}, status=504)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


app = web.Application()
app.router.add_post("/synthesize", handle_synthesize)
app.router.add_post("/synthesize-openai", handle_synthesize_openai)
app.router.add_get("/health", handle_health)

if __name__ == "__main__":
    print(f"[tts_server] Starting on port {PORT}", flush=True)
    web.run_app(app, host="127.0.0.1", port=PORT, print=None)
