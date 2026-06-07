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
            f"Transcribe ONLY the spoken words from {time_range} (mm:ss format).\n\n"
            "Rules:\n"
            "- Output ONLY the spoken text, nothing else\n"
            "- No timestamps, no speaker labels, no section headers\n"
            "- No preamble, no explanation, no markdown\n"
            "- Just the exact words spoken during that time range\n"
            "- If there is no speech in that range, output exactly: [no speech]\n"
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
        if not text:
            return web.json_response({"error": "النص فارغ"}, status=400)

        client = await get_client()

        context_block = ""
        if context:
            context_block = (
                "PREVIOUS SEGMENT (for context continuity only — do NOT retranslate it):\n"
                f"{context}\n\n"
            )

        prompt = (
            "You are a world-class multilingual subtitle restoration and Arabic localization engine.\n\n"
            "Your job is not simple translation.\n"
            "Your job is to understand broken, noisy, partial, auto-generated, or mistranscribed speech from any language, recover the intended meaning, and render it into fluent, natural Arabic as if written by a professional human subtitle editor.\n\n"
            "CORE OBJECTIVE\n"
            "Convert every input into clear, natural Arabic while preserving the speaker's intended meaning, tone, and context.\n\n"
            "PRIMARY RULES\n"
            "1) Output only the final Arabic text.\n"
            "   - Do not explain.\n"
            "   - Do not add notes.\n"
            "   - Do not mention uncertainty.\n"
            "   - Do not show alternatives.\n"
            "   - Do not prefix or suffix anything.\n\n"
            "2) Translate everything into Arabic.\n"
            "   This includes:\n"
            "   - full sentences\n"
            "   - fragments\n"
            "   - names\n"
            "   - brands\n"
            "   - places\n"
            "   - titles\n"
            "   - slang\n"
            "   - abbreviations\n"
            "   - memes\n"
            "   - internet expressions\n"
            "   - hashtags\n"
            "   - usernames\n"
            "   - technical terms\n"
            "   - mixed-language phrases\n"
            "   - numbers, dates, currencies, and measurements\n\n"
            "3) When a foreign word, name, or brand appears, render it in natural Arabic form.\n"
            "   Examples:\n"
            "   - John → جون\n"
            "   - New York → نيويورك\n"
            "   - Samsung → سامسونج\n"
            "   - Bitcoin → بيتكوين\n\n"
            "4) If the source text is broken, noisy, duplicated, incomplete, or corrupted:\n"
            "   - reconstruct the intended meaning\n"
            "   - remove junk fragments\n"
            "   - remove repeated words caused by auto-captions\n"
            "   - repair grammar and sentence flow\n"
            "   - infer missing connectives and pronouns when obvious\n"
            "   - choose the most likely intended reading\n\n"
            "5) Prioritize meaning over literal wording.\n"
            "   - Do not translate word-for-word if that produces unnatural Arabic.\n"
            "   - Preserve intent, not raw structure.\n"
            "   - Make the result sound like professional Arabic subtitles or Arabic dubbing.\n\n"
            "6) Preserve tone and intent.\n"
            "   Keep the emotional and stylistic force of the original:\n"
            "   - excitement\n"
            "   - humor\n"
            "   - sarcasm\n"
            "   - anger\n"
            "   - urgency\n"
            "   - fear\n"
            "   - irony\n"
            "   - seriousness\n"
            "   - whispering\n"
            "   - shouting\n\n"
            "7) Handle unclear audio intelligently.\n"
            "   If the transcript is partially unintelligible:\n"
            "   - infer the most probable meaning from context\n"
            "   - produce the closest coherent Arabic sentence\n"
            "   - do not copy nonsense into the output\n\n"
            "8) Use context aggressively.\n"
            "   If previous or next subtitle context is available, use it to resolve:\n"
            "   - pronouns\n"
            "   - pronoun drops\n"
            "   - cut-off sentences\n"
            "   - ambiguous references\n"
            "   - speaker continuity\n"
            "   - topic continuity\n\n"
            "9) Normalize Arabic output.\n"
            "   The final Arabic must be:\n"
            "   - fluent\n"
            "   - clean\n"
            "   - natural\n"
            "   - readable\n"
            "   - grammatically sound\n"
            "   - suitable for subtitles\n"
            "   - suitable for voice dubbing\n\n"
            "10) Remove filler noise unless it carries meaning.\n"
            "    Examples of noise to remove:\n"
            "    - uh\n"
            "    - um\n"
            "    - ah\n"
            "    - repeated syllables\n"
            "    - false starts\n"
            "    - auto-caption artifacts\n"
            "    - filler repetitions\n\n"
            "11) Preserve meaningful non-speech elements only when useful.\n"
            "    Keep or convert:\n"
            "    - laughter\n"
            "    - pauses\n"
            "    - emphasis\n"
            "    - interjections\n"
            "    - sound effects\n"
            "    - textual cues that matter to meaning\n\n"
            "12) If multiple languages are mixed together:\n"
            "    unify everything into Arabic.\n\n"
            "13) Translate slang and internet language naturally into Arabic equivalents.\n"
            "    Do not keep the original slang unless it is a fixed proper noun or impossible to localize.\n\n"
            "14) Translate profanity and informal speech naturally and accurately.\n"
            "    Do not over-censor unless the source explicitly requires it.\n\n"
            "15) For technical, scientific, gaming, business, and cultural content:\n"
            "    use the most natural Arabic equivalent that preserves the original meaning and audience intent.\n\n"
            "16) If the text contains websites, channel names, handles, hashtags, or platform names:\n"
            "    render them naturally in Arabic pronunciation or Arabic-friendly form when appropriate.\n\n"
            "17) If numbers or symbols are attached to meaning:\n"
            "    convert them into readable Arabic forms.\n"
            "    Examples:\n"
            "    - 2024 → ٢٠٢٤ or 2024 depending on style consistency\n"
            "    - $10 → 10 دولار\n"
            "    - 50% → 50 بالمئة\n\n"
            "18) Never produce robotic, overly literal, or awkward Arabic.\n"
            "    The result must read like a professional human subtitle translator carefully cleaned and localized it.\n\n"
            "19) If the input is extremely chaotic:\n"
            "    produce the closest coherent Arabic interpretation without adding unrelated content.\n\n"
            "20) Keep the translation compact and subtitle-friendly.\n"
            "    Do not over-expand unless needed to restore meaning.\n\n"
            "QUALITY STANDARD\n"
            "The output should feel like:\n"
            "- professional Arabic subtitles\n"
            "- high-quality Arabic dubbing text\n"
            "- fluent native Arabic narration\n"
            "- a human editor repaired the original transcript\n\n"
            f"{context_block}"
            f"INPUT:\n{text}\n\n"
            "OUTPUT:"
        )

        response = await client.generate_content(prompt)
        raw = (response.text or "").strip()
        if not raw:
            raise ValueError("نتيجة فارغة من Gemini")
        translation = clean_response(raw)
        if not translation:
            translation = raw
        return web.json_response({"translation": translation})
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
