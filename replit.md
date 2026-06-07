# مترجم الفيديو — Dot Command

تطبيق ويب يترجم مقاطع يوتيوب فورياً إلى العربية باستخدام Gemini AI وتحويل النص إلى كلام.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — تشغيل خادم API (المنفذ 8080)
- `pnpm --filter @workspace/video-translator run dev` — تشغيل واجهة المستخدم
- `pnpm run typecheck` — فحص الأنواع لجميع الحزم
- `pnpm run build` — بناء جميع الحزم
- `pnpm --filter @workspace/api-spec run codegen` — إعادة توليد hooks و Zod schemas

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Frontend: React + Vite + TailwindCSS + shadcn/ui + Framer Motion
- AI: Gemini WebAPI (عبر كوكيز المتصفح)
- TTS: Edge TTS (Microsoft) + OpenAI.fm
- Transcription: faster-whisper (tiny model) + yt-dlp
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — عقد API (المصدر الوحيد للحقيقة)
- `lib/api-client-react/src/generated/` — React Query hooks المولّدة تلقائياً
- `lib/api-zod/src/generated/` — Zod schemas المولّدة تلقائياً
- `artifacts/api-server/src/routes/translate/` — مسارات معالجة الفيديو
- `artifacts/api-server/tts_server.py` — خادم TTS المستمر (المنفذ 19998)
- `artifacts/api-server/gemini_server.py` — خادم Gemini المستمر (المنفذ 19999)
- `artifacts/api-server/transcribe.py` — Whisper transcription script
- `artifacts/video-translator/src/pages/Home.tsx` — الصفحة الرئيسية

## Architecture decisions

- الخوادم Python تعمل بشكل مستمر لتجنب overhead التهيئة لكل طلب
- نظام ذكي للسرعة: TTS يُضبط حتى 1.7× والفيديو يتكيف للحفاظ على التزامن
- تشغيل مزدوج للصوت (slot A و B) للتشغيل بدون انقطاع بين المقاطع
- كل مقطع 60 ثانية مع تداخل 1 ثانية للتغطية الكاملة
- Gemini يُستخدم للنسخ والترجمة معاً (يتجاوز قيود IP)

## Product

- إدخال رابط يوتيوب → ترجمة فورية إلى العربية مع صوت عربي متزامن مع الفيديو
- دعم أصوات متعددة: OpenAI.fm (11 صوت) + Edge TTS عربية وإنجليزية
- استخراج النص عبر: ترجمات يوتيوب التلقائية → Gemini AI → Whisper
- إدارة كوكيز Gemini للوصول غير المقيد

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Python scripts تستخدم `/home/runner/workspace/.pythonlibs/bin/python3`
- TTS server يعمل على المنفذ 19998، Gemini server على 19999
- الكوكيز تُحفظ في `/tmp/yt-cookies.txt`
- ffmpeg مثبت مسبقاً في بيئة Replit
- `pnpm run dev` في جذر المشروع غير موجود — استخدم workflows

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
