import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, unlink, readFile, copyFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { logger } from "../../lib/logger.js";
import { updateJob } from "./jobs.js";
import { synthesizeEdgeTTS, EDGE_TTS_VOICES } from "./edge-tts.js";
import { hasCookies, getCookiesPath } from "./cookies.js";
import { translateWithGemini, getTranscriptWithGemini } from "./gemini.js";
import { readdirSync } from "fs";

const execFileAsync = promisify(execFile);

const workspaceRoot = "/home/runner/workspace";
const venvBinPath = join(workspaceRoot, ".venv", "bin");
const pythonLibsPath = join(workspaceRoot, ".pythonlibs", "bin");
const pythonBin = join(pythonLibsPath, "python3");
for (const p of [venvBinPath, pythonLibsPath]) {
  if (!process.env.PATH?.includes(p)) {
    process.env.PATH = `${p}:${process.env.PATH || ""}`;
  }
}

// How many seconds of audio/video to download per segment (includes 1s overlap)
const SEGMENT_DURATION = 60;

// How far the video advances before switching to the next segment.
// 1 second shorter than SEGMENT_DURATION → overlapping coverage:
//   Seg 0:   0–60s
//   Seg 1:  59–119s
//   Seg 2: 118–178s
// This guarantees speech near the segment boundary is captured in the NEXT segment's transcript.
const SEGMENT_STRIDE = 59;

// ── Smart Speed Constants ──────────────────────────────────────────────────
const MIN_ATEMPO = 1.0;
const MAX_ATEMPO = 1.7;

const audioJobMap = new Map<string, string>();
const lastTranslationByUrl = new Map<string, string>();

export function getAudioPath(jobId: string): string | undefined {
  return audioJobMap.get(jobId);
}

export { EDGE_TTS_VOICES as TTS_VOICES };

export type TranslationEngine = "openai" | "google" | "pollinations";

interface ProcessOptions {
  jobId: string;
  videoUrl: string;
  startTime: number;
  voice: string;
  translationEngine?: TranslationEngine;
  forceAudioExtraction?: boolean;
}

async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath,
    ]);
    const dur = parseFloat(stdout.trim());
    return isNaN(dur) ? SEGMENT_DURATION : dur;
  } catch {
    return SEGMENT_DURATION;
  }
}

/**
 * Apply ffmpeg atempo filter to change audio speed.
 * atempo supports 0.5–100 directly; we only use 1.0–1.7 so no chaining needed.
 */
async function applyAtempo(inputPath: string, outputPath: string, speed: number): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-i", inputPath,
    "-filter:a", `atempo=${speed.toFixed(4)}`,
    "-ar", "22050",
    "-q:a", "2",
    "-y",
    outputPath,
  ], { timeout: 60_000 });
}

function cleanYouTubeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      return `https://youtu.be${u.pathname}`;
    }
    const newParams = new URLSearchParams();
    if (u.searchParams.has("v")) newParams.set("v", u.searchParams.get("v")!);
    u.search = newParams.toString();
    return u.toString();
  } catch {
    return url;
  }
}

function parseVTTTime(ts: string): number {
  const parts = ts.split(":");
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
}

function parseVTTForTimeRange(content: string, start: number, end: number): string {
  const seen = new Set<string>();
  const texts: string[] = [];
  const lines = content.split("\n");

  let inRange = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const tsMatch = line.match(/(\d{1,2}:\d{2}[:.]\d{3})\s+-->\s+(\d{1,2}:\d{2}[:.]\d{3})/);
    if (tsMatch) {
      const blockStart = parseVTTTime(tsMatch[1].replace(",", "."));
      const blockEnd   = parseVTTTime(tsMatch[2].replace(",", "."));
      inRange = blockStart < end && blockEnd > start;
      continue;
    }
    if (inRange && line && !line.startsWith("WEBVTT") && !line.startsWith("NOTE") && !/^\d+$/.test(line)) {
      const clean = line.replace(/<[^>]+>/g, "").trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        texts.push(clean);
      }
    }
  }
  return texts.join(" ");
}

async function getYouTubeCaptions(
  videoUrl: string,
  startTime: number,
  cookiesArgs: string[]
): Promise<string | null> {
  const tmpDir = await mkdtemp(join(tmpdir(), "vt-caps-"));
  const outputTemplate = join(tmpDir, "caps");

  try {
    const langCandidates = ["en", "en-US", "en-GB"];
    for (const lang of langCandidates) {
      try {
        await execFileAsync("yt-dlp", [
          "--write-auto-subs",
          "--no-write-subs",
          "--sub-lang", lang,
          "--sub-format", "vtt",
          "--skip-download",
          "--no-playlist",
          "--no-check-certificates",
          "-o", outputTemplate,
          ...cookiesArgs,
          videoUrl,
        ], { timeout: 30_000 });

        let vttPath = "";
        try {
          const files = readdirSync(tmpDir);
          const vttFile = files.find(f => f.endsWith(".vtt"));
          if (vttFile) vttPath = join(tmpDir, vttFile);
        } catch { /* ignore */ }

        if (vttPath && existsSync(vttPath)) {
          const content = await readFile(vttPath, "utf8");
          await unlink(vttPath).catch(() => {});
          const text = parseVTTForTimeRange(content, startTime, startTime + SEGMENT_DURATION);
          if (text.trim().length > 10) return text.trim();
        }
      } catch { /* try next lang */ }
    }
  } catch { /* ignore */ } finally {
    try {
      const files = readdirSync(tmpDir);
      for (const f of files) await unlink(join(tmpDir, f)).catch(() => {});
    } catch { /* ignore */ }
  }
  return null;
}

async function downloadAudioSegment(
  videoUrl: string,
  startTime: number,
  outputPath: string,
  cookiesArgs: string[]
): Promise<void> {
  const safeUrl = cleanYouTubeUrl(videoUrl);

  async function tryClient(client: string): Promise<string> {
    const { stdout } = await execFileAsync("yt-dlp", [
      "-f", "bestaudio/best",
      "--get-url",
      "--no-playlist",
      "--extractor-args", `youtube:player_client=${client}`,
      "--no-check-certificates",
      ...cookiesArgs,
      safeUrl,
    ], { timeout: 60_000 });
    const line = stdout.split("\n").find(l => l.trim().startsWith("http"));
    return line?.trim() ?? "";
  }

  let audioUrl = "";
  let lastErr: Error | null = null;
  for (const client of ["mweb", "android", "ios", "web"]) {
    try {
      audioUrl = await tryClient(client);
      if (audioUrl.startsWith("http")) break;
    } catch (e: any) {
      lastErr = e;
    }
  }

  if (!audioUrl) {
    const msg = lastErr?.message || "خطأ غير معروف";
    if (msg.includes("Sign in") || msg.includes("bot")) {
      throw new Error("يوتيوب يطلب تسجيل الدخول. يرجى إضافة الكوكيز.");
    }
    throw new Error(`فشل الحصول على رابط الصوت: ${msg}`);
  }

  await execFileAsync("ffmpeg", [
    "-ss", String(startTime),
    "-t", String(SEGMENT_DURATION),
    "-i", audioUrl,
    "-vn", "-ar", "16000", "-ac", "1",
    "-f", "mp3", "-y",
    outputPath,
  ], { timeout: 120_000 });
}

const TRANSCRIBE_SCRIPT = join(process.cwd(), "transcribe.py");

async function transcribeWithWhisper(audioPath: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    pythonBin,
    [TRANSCRIBE_SCRIPT, audioPath],
    { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 }
  );
  if (stderr) logger.warn({ stderr: stderr.slice(0, 300) }, "Transcribe stderr");
  const result = JSON.parse(stdout.trim()) as { text?: string; error?: string };
  if (result.error) throw new Error(`فشل التعرف على الكلام: ${result.error}`);
  if (!result.text) throw new Error("نتيجة فارغة من التعرف على الكلام");
  return result.text;
}

async function translateWithGoogle(text: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ar&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!response.ok) throw new Error(`Google Translate: ${response.status}`);
  const data = await response.json() as any[][];
  let result = "";
  if (Array.isArray(data?.[0])) {
    for (const part of data[0]) {
      if (Array.isArray(part) && part[0]) result += part[0];
    }
  }
  if (!result.trim()) throw new Error("Google Translate returned empty result");
  return result.trim();
}

async function translateWithPollinations(text: string): Promise<string> {
  const prompt = `Translate the following text to Arabic. Return only the Arabic translation:\n\n${text}`;
  const url = `https://text.pollinations.ai/${encodeURIComponent(prompt)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!response.ok) throw new Error(`Pollinations: ${response.status}`);
  const result = await response.text();
  if (!result.trim()) throw new Error("Pollinations returned empty result");
  return result.trim();
}

export async function processVideoSegment(options: ProcessOptions): Promise<void> {
  const { jobId, videoUrl, startTime, voice, forceAudioExtraction = false } = options;

  let audioInputPath = "";
  let naturalPath = "";
  let audioOutputPath = "";

  try {
    const cookiesAvailable = await hasCookies();
    const cookiesArgs = cookiesAvailable ? ["--cookies", getCookiesPath()] : [];
    const safeUrl = cleanYouTubeUrl(videoUrl);

    const tmpDir = await mkdtemp(join(tmpdir(), "vt-"));
    audioInputPath = join(tmpDir, `${jobId}-input.mp3`);
    naturalPath    = join(tmpDir, `${jobId}-natural.mp3`);
    audioOutputPath = join(tmpDir, `${jobId}-output.mp3`);

    updateJob(jobId, { status: "processing", progress: "⬇️ تنزيل الصوت من يوتيوب..." });
    logger.info({ jobId, startTime }, "Starting video processing");

    // ── Step 1: Get transcript ─────────────────────────────────────────────

    let transcript = "";

    if (!forceAudioExtraction) {
      // Primary: yt-dlp auto captions
      updateJob(jobId, { progress: "📝 محاولة ترجمات يوتيوب التلقائية..." });
      try {
        transcript = await getYouTubeCaptions(safeUrl, startTime, cookiesArgs) ?? "";
      } catch { /* fall through */ }

      if (transcript) {
        logger.info({ jobId, chars: transcript.length }, "Got YouTube captions via yt-dlp");
      } else {
        // Secondary: Gemini direct YouTube transcript (bypasses IP blocks)
        updateJob(jobId, { progress: "🤖 استخراج النص عبر Gemini AI..." });
        try {
          transcript = await getTranscriptWithGemini(safeUrl, startTime, SEGMENT_DURATION);
          if (transcript) {
            logger.info({ jobId, chars: transcript.length }, "Got transcript via Gemini");
          }
        } catch (e: any) {
          logger.warn({ jobId, err: e?.message }, "Gemini transcript failed, will try audio extraction");
        }
      }
    }

    if (!transcript) {
      const extractMsg = forceAudioExtraction
        ? "⬇️ تنزيل الصوت من الفيديو..."
        : "⬇️ تنزيل الصوت (لم تُوجد ترجمات)...";
      updateJob(jobId, { progress: extractMsg });

      let audioDownloaded = false;
      try {
        await downloadAudioSegment(safeUrl, startTime, audioInputPath, cookiesArgs);
        audioDownloaded = existsSync(audioInputPath);
      } catch (e: any) {
        logger.warn({ jobId, err: e?.message }, "Audio download failed");
      }

      if (audioDownloaded) {
        updateJob(jobId, { progress: "🎙️ تحويل الصوت إلى نص بالذكاء الاصطناعي..." });
        logger.info({ jobId, forceAudioExtraction }, "Transcribing audio with AI");
        transcript = await transcribeWithWhisper(audioInputPath);
      } else {
        // Last resort: Gemini transcript regardless of mode
        updateJob(jobId, { progress: "🤖 استخراج النص عبر Gemini AI (بديل)..." });
        transcript = await getTranscriptWithGemini(safeUrl, startTime, SEGMENT_DURATION);
        if (transcript) {
          logger.info({ jobId, chars: transcript.length }, "Got transcript via Gemini (fallback)");
        }
      }
    }

    if (!transcript || transcript.trim().length < 3) {
      throw new Error("لم يتم اكتشاف كلام في هذا المقطع");
    }

    // ── Step 2: Translate ──────────────────────────────────────────────────

    updateJob(jobId, { transcript, progress: "🌍 ترجمة النص إلى العربية..." });
    logger.info({ jobId, transcript: transcript.slice(0, 100) }, "Translating");

    const prevTranslation = lastTranslationByUrl.get(safeUrl) ?? "";
    const translation = await translateWithGemini(transcript, prevTranslation);
    lastTranslationByUrl.set(safeUrl, translation.slice(-300));

    if (!translation.trim()) throw new Error("فشلت الترجمة: نتيجة فارغة");

    // ── Step 3: TTS at natural rate ────────────────────────────────────────

    updateJob(jobId, { translation, progress: "🔊 توليد الصوت العربي..." });
    logger.info({ jobId }, "Generating TTS at natural rate");

    await synthesizeEdgeTTS(translation, voice, 1.0, naturalPath);

    if (!existsSync(naturalPath)) {
      throw new Error("فشل توليد الصوت");
    }

    // ── Step 4: Smart speed calculation ───────────────────────────────────
    //
    //   required_speed = naturalDuration / SEGMENT_DURATION
    //   Case A (≤ MAX_ATEMPO): ttsSpeed = required_speed, videoSlowdown = 1.0
    //   Case B (> MAX_ATEMPO): ttsSpeed = MAX_ATEMPO, videoSlowdown = required_speed / MAX_ATEMPO
    //
    //   Frontend formula:
    //     audio.playbackRate = 1.0
    //     video_rate = SEGMENT_DURATION / audio.duration   (always keeps A/V in sync)

    const naturalDuration = await getAudioDuration(naturalPath);
    // Use SEGMENT_STRIDE (59s) as the reference — TTS must fit within the stride window,
    // not the full 60s download, because the frontend transitions at stride boundaries.
    const requiredSpeed   = naturalDuration / SEGMENT_STRIDE;
    const ttsSpeed        = Math.min(Math.max(requiredSpeed, MIN_ATEMPO), MAX_ATEMPO);
    const videoSlowdown   = requiredSpeed > MAX_ATEMPO ? requiredSpeed / MAX_ATEMPO : 1.0;

    logger.info(
      { jobId, naturalDuration, stride: SEGMENT_STRIDE, requiredSpeed: requiredSpeed.toFixed(3), ttsSpeed: ttsSpeed.toFixed(3), videoSlowdown: videoSlowdown.toFixed(3) },
      "Smart speed calculated"
    );

    updateJob(jobId, { progress: "⚙️ تطبيق سرعة النطق الذكية..." });

    // ── Step 5: Apply atempo via ffmpeg ────────────────────────────────────

    if (ttsSpeed > 1.02) {
      // Speed up TTS audio; atempo=1.0–1.7 is safe without chaining
      await applyAtempo(naturalPath, audioOutputPath, ttsSpeed);
    } else {
      // TTS already fits within or under the segment — just copy
      await copyFile(naturalPath, audioOutputPath);
    }

    if (!existsSync(audioOutputPath)) {
      throw new Error("فشل معالجة الصوت");
    }

    audioJobMap.set(jobId, audioOutputPath);
    updateJob(jobId, {
      status: "completed",
      progress: "✅ اكتمل! جاهز للتشغيل",
      suggestedRate: ttsSpeed,
      videoSlowdown,
    });
    logger.info(
      { jobId, ttsSpeed: ttsSpeed.toFixed(3), videoSlowdown: videoSlowdown.toFixed(3) },
      "Processing complete"
    );

  } catch (err: any) {
    const msg = err?.message || "خطأ غير معروف";
    logger.error({ jobId, err: msg }, "Processing failed");
    updateJob(jobId, {
      status: "failed",
      progress: `❌ خطأ: ${msg}`,
      error: msg,
    });
  } finally {
    // Clean up temp input files (keep output — served to client)
    for (const p of [audioInputPath, naturalPath]) {
      try { if (p && existsSync(p)) await unlink(p); } catch { /* ignore */ }
    }
  }
}
