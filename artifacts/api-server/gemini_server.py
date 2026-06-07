#!/usr/bin/env python3
"""
Persistent Gemini translation server — keeps GeminiClient alive between requests.
Eliminates per-request initialization overhead (~25-40s saved per call).
"""
import asyncio
import json
import sys
import os
from aiohttp import web

PORT = int(os.environ.get("GEMINI_SERVER_PORT", "19999"))
COOKIES_PATH = "/tmp/yt-cookies.txt"

_client = None
_init_lock = asyncio.Lock()

def parse_cookies(path: str) -> dict:
    wanted = {"__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-3PSID"}
    result = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) >= 7 and parts[5] in wanted:
                    result[parts[5]] = parts[6]
    except Exception:
        pass
    return result

async def get_client():
    global _client
    async with _init_lock:
        if _client is not None:
            return _client
        from gemini_webapi import GeminiClient
        cookies = parse_cookies(COOKIES_PATH)
        psid = cookies.get("__Secure-1PSID", "")
        psidts = cookies.get("__Secure-1PSIDTS", "")
        if not psid:
            raise ValueError("__Secure-1PSID غير موجود في ملف الكوكيز")
        client = GeminiClient(secure_1psid=psid, secure_1psidts=psidts)
        await client.init(timeout=30, auto_close=False, close_delay=3600, auto_refresh=True)
        _client = client
        return client

def clean_response(text: str) -> str:
    """Remove common Gemini preambles/postambles that pollute the translation."""
    import re
    lines = text.strip().splitlines()

    # Patterns that indicate a preamble/header line (not actual translation)
    skip_patterns = [
        r"^(here\s+is|here'?s)\b",
        r"^(the\s+)?translation\s*:?$",
        r"^arabic\s+(translation|text)\s*:?$",
        r"^output\s*:?$",
        r"^result\s*:?$",
        r"^note\s*:",
        r"^ملاحظة\s*:",
        r"^إليك\s+الترجمة",
        r"^هذه\s+الترجمة",
        r"^الترجمة\s*(العربية)?\s*:?$",
        r"^\*{1,3}ترجمة\*{1,3}",
        r"^\*{1,3}translation\*{1,3}",
    ]

    # Drop leading lines that match skip patterns
    while lines:
        l = lines[0].strip().lower()
        if any(re.match(p, l, re.IGNORECASE) for p in skip_patterns):
            lines.pop(0)
        else:
            break

    # Drop trailing lines that match skip patterns or are blank
    while lines:
        l = lines[-1].strip().lower()
        if not l or any(re.match(p, l, re.IGNORECASE) for p in skip_patterns):
            lines.pop()
        else:
            break

    result = "\n".join(lines).strip()

    # Strip markdown bold/italic wrappers if the whole text is wrapped
    result = re.sub(r"^\*{1,3}(.+?)\*{1,3}$", r"\1", result, flags=re.DOTALL)

    return result


def extract_code_block(text: str) -> str:
    """Extract content from a markdown code block if present, otherwise return as-is."""
    import re
    match = re.search(r"```(?:text|arabic|ar)?\s*\n(.*?)```", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    # Also handle single-line code blocks
    match = re.search(r"```(?:text|arabic|ar)?\s*(.*?)```", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return text


def strip_timestamps(text: str) -> str:
    """Remove [HH:MM:SS] timestamps from text, returning clean text for TTS."""
    import re
    # Remove [HH:MM:SS] patterns (with optional space after)
    clean = re.sub(r"\[\d{2}:\d{2}:\d{2}\]\s*", "", text)
    # Collapse multiple newlines into a single space
    clean = re.sub(r"[\r\n]+", " ", clean)
    # Collapse multiple spaces
    clean = re.sub(r"\s{2,}", " ", clean)
    return clean.strip()


async def handle_transcript(request: web.Request) -> web.Response:
    """Extract transcript from a YouTube video URL for a given time range using Gemini."""
    try:
        data = await request.json()
        video_url = (data.get("url") or "").strip()
        start_time = int(data.get("start", 0))
        duration = int(data.get("duration", 60))

        if not video_url:
            return web.json_response({"error": "URL مطلوب"}, status=400)

        client = await get_client()

        start_m = start_time // 60
        start_s = start_time % 60
        end_time = start_time + duration
        end_m = end_time // 60
        end_s = end_time % 60
        time_range = f"{start_m:02d}:{start_s:02d} to {end_m:02d}:{end_s:02d}"

        prompt = (
            f"Watch this YouTube video: {video_url}\n\n"
            f"Your task: extract ALL dialogue and on-screen text from {time_range} (mm:ss format).\n\n"
            "WHAT TO CAPTURE:\n"
            "1. Every word spoken by any character or narrator during this time range\n"
            "2. Any text displayed on-screen that is part of the story (subtitles burned into the video, character name cards, title text, skill/ability names shown on screen)\n"
            "3. Translated subtitles shown on screen if they represent the dialogue\n\n"
            "OUTPUT RULES:\n"
            "- Output the complete dialogue text as a continuous narrative\n"
            "- No timestamps, no speaker labels, no section headers\n"
            "- No preamble, no explanation, no markdown formatting\n"
            "- Preserve the natural speaking order and flow\n"
            "- Include ALL words — do not summarize or skip any dialogue\n"
            "- If there is truly no speech AND no relevant on-screen text: output exactly [no speech]\n"
        )

        response = await client.generate_content(prompt)
        text = (response.text or "").strip()

        if not text or "[no speech]" in text.lower():
            return web.json_response({"transcript": "", "empty": True})

        # Clean any Gemini preamble from the transcript response
        cleaned = clean_response(text)
        return web.json_response({"transcript": cleaned or text})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_translate(request: web.Request) -> web.Response:
    try:
        data = await request.json()
        text = (data.get("text") or "").strip()
        context = (data.get("context") or "").strip()
        video_url = (data.get("videoUrl") or "").strip()
        start_time = int(data.get("startTime") or 0)
        if not text:
            return web.json_response({"error": "النص فارغ"}, status=400)

        client = await get_client()

        # Build HH:MM:SS timeframe string from startTime (seconds)
        h = start_time // 3600
        m = (start_time % 3600) // 60
        s = start_time % 60
        timeframe = f"{h:02d}:{m:02d}:{s:02d}"

        context_block = ""
        if context:
            context_block = (
                "PREVIOUS SEGMENT (for context continuity — do NOT retranslate it):\n"
                f"{context}\n\n"
            )

        video_block = ""
        if video_url:
            video_block = (
                f"[VIDEO URL: {video_url}]\n"
                f"[REQUIRED TIMEFRAME: {timeframe}]\n\n"
            )

        prompt = (
            f"{video_block}"
            "You are a world-class multilingual subtitle restoration and Arabic localization engine.\n\n"
            "Your job is not simple translation.\n"
            "Your job is to understand broken, noisy, partial, auto-generated, or mistranscribed speech "
            "from any language, recover the intended meaning, and render it into fluent, natural Arabic "
            "as if written by a professional human subtitle editor.\n\n"
            "CORE OBJECTIVE\n"
            "Convert every input into clear, natural Arabic while preserving the speaker's intended "
            "meaning, tone, and context ONLY for the exact 60-second block of the specified timeframe.\n\n"
            "CRITICAL TIMESTAMP RULE:\n"
            "- Every sentence or distinct phrase MUST start with its own [HH:MM:SS] timestamp on a new line.\n"
            f"- Timestamps start from {timeframe} and increment second-by-second up to the end of the minute.\n"
            "- Format: [HH:MM:SS] Arabic text\n"
            "- Do NOT combine multiple sentences under one timestamp.\n"
            "- Timestamps must be 100% accurate and synchronized with the actual video timeline.\n"
            "- Output the final text inside a single Markdown code block (```text ... ```).\n\n"
            "SIMPLIFIED LANGUAGE RULE:\n"
            "- Use simple, clear, modern standard Arabic — avoid rare or archaic words.\n"
            "- Keep phrasing natural and accessible.\n\n"
            "PRIMARY RULES\n"
            "1) Output only the final Arabic text inside the code block with timestamps.\n"
            "   - Do not explain, add notes, show alternatives, or add anything outside the code block.\n\n"
            "2) Translate everything into Arabic: sentences, fragments, names, brands, places, slang, "
            "numbers, technical terms, mixed-language phrases.\n\n"
            "3) Foreign names/brands → natural Arabic pronunciation:\n"
            "   John → جون | New York → نيويورك | Samsung → سامسونج\n\n"
            "4) Fix broken/noisy input: remove junk, repair grammar, reconstruct meaning.\n\n"
            "5) Prioritize meaning over literal wording — sound like professional Arabic subtitles.\n\n"
            "6) Preserve tone: excitement, humor, sarcasm, anger, urgency, fear, irony, seriousness.\n\n"
            "7) Handle unclear audio: infer the most probable meaning from context.\n\n"
            "8) Use context aggressively to resolve pronouns, cut-offs, and speaker continuity.\n\n"
            "9) Output must be fluent, clean, natural, grammatically sound Arabic for subtitles.\n\n"
            "10) Remove filler noise (uh, um, ah, repeated syllables, auto-caption artifacts).\n\n"
            "11) Preserve meaningful non-speech elements (laughter, pauses, interjections).\n\n"
            "12) Unify all languages into Arabic.\n\n"
            "13) Translate slang and internet language into natural Arabic equivalents.\n\n"
            "14) Translate profanity naturally and accurately.\n\n"
            "15) For gaming/tech/business content: use the most natural Arabic equivalent.\n\n"
            "16) Convert numbers/symbols to readable Arabic (50% → 50 بالمئة | $10 → 10 دولار).\n\n"
            "17) Never produce robotic, overly literal, or awkward Arabic.\n\n"
            "18) Keep translation compact and subtitle-friendly.\n\n"
            "QUALITY STANDARD\n"
            "Output should feel like: professional Arabic subtitles with accurate second-by-second "
            "timestamps, high-quality dubbing text, fluent native Arabic narration.\n\n"
            f"{context_block}"
            f"INPUT TEXT TO TRANSLATE:\n{text}\n\n"
            "OUTPUT (inside ```text code block with [HH:MM:SS] timestamps):"
        )

        response = await client.generate_content(prompt)
        raw = (response.text or "").strip()
        if not raw:
            raise ValueError("نتيجة فارغة من Gemini")

        # Extract content from markdown code block if Gemini wrapped it
        timestamped = extract_code_block(raw)
        if not timestamped:
            timestamped = clean_response(raw)

        # Strip timestamps to get clean text for TTS
        clean_text = strip_timestamps(timestamped)
        if not clean_text:
            clean_text = strip_timestamps(raw)

        return web.json_response({
            "translation": timestamped,  # Full text with [HH:MM:SS] timestamps
            "cleanText": clean_text,     # Timestamps stripped — for TTS
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_reload(request: web.Request) -> web.Response:
    global _client
    try:
        if _client is not None:
            try: await _client.close()
            except: pass
        _client = None
        await get_client()
        return web.json_response({"ok": True, "message": "تم إعادة تهيئة عميل Gemini"})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

async def handle_health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "initialized": _client is not None})

app = web.Application()
app.router.add_post("/translate", handle_translate)
app.router.add_post("/transcript", handle_transcript)
app.router.add_post("/reload", handle_reload)
app.router.add_get("/health", handle_health)

if __name__ == "__main__":
    print(f"[gemini_server] Starting on port {PORT}", flush=True)
    web.run_app(app, host="127.0.0.1", port=PORT, print=None)
