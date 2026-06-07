#!/usr/bin/env python3
import sys
import json
import asyncio

def extract_cookies(cookies_path: str) -> dict:
    wanted = {
        "__Secure-1PSID": None,
        "__Secure-1PSIDTS": None,
        "__Secure-3PSID": None,
        "SAPISID": None,
        "SIDCC": None,
    }
    try:
        with open(cookies_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) >= 7:
                    name = parts[5]
                    value = parts[6]
                    if name in wanted:
                        wanted[name] = value
    except Exception as e:
        print(json.dumps({"valid": False, "error": str(e), "message": "فشل قراءة ملف الكوكيز"}))
        sys.exit(0)
    return {k: v for k, v in wanted.items() if v}

async def validate(cookies_path: str):
    from gemini_webapi import GeminiClient

    cookies = extract_cookies(cookies_path)
    psid = cookies.get("__Secure-1PSID")
    psidts = cookies.get("__Secure-1PSIDTS")

    if not psid:
        print(json.dumps({
            "valid": False,
            "message": "ناقصة: __Secure-1PSID مفقود",
            "hasPSID": False,
            "hasPSIDTS": False,
        }))
        return

    try:
        client = GeminiClient(
            secure_1psid=psid,
            secure_1psidts=psidts or "",
        )
        await client.init(timeout=20, auto_close=False, close_delay=60, auto_refresh=False)
        response = await client.generate_content("Say OK in Arabic (one word).")
        await client.close()
        print(json.dumps({
            "valid": True,
            "message": "كوكيز Gemini تعمل بشكل صحيح ✅",
            "hasPSID": True,
            "hasPSIDTS": psidts is not None,
            "testResponse": response.text.strip()[:50],
        }))
    except Exception as e:
        msg = str(e)
        if "cookie" in msg.lower() or "auth" in msg.lower() or "403" in msg or "401" in msg:
            status_msg = "الكوكيز منتهية الصلاحية أو غير صالحة ❌"
        else:
            status_msg = f"خطأ في الاتصال: {msg[:80]}"
        print(json.dumps({
            "valid": False,
            "message": status_msg,
            "hasPSID": True,
            "hasPSIDTS": psidts is not None,
            "error": msg[:100],
        }))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"valid": False, "message": "مسار ملف الكوكيز مطلوب"}))
        sys.exit(1)
    asyncio.run(validate(sys.argv[1]))
