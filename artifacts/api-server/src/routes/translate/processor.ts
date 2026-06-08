import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, unlink, copyFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { logger } from "../../lib/logger.js";
import { updateJob } from "./jobs.js";
import { synthesizeEdgeTTS, EDGE_TTS_VOICES } from "./edge-tts.js";
import { hasCookies, getCookiesPath } from "./cookies.js";
import { translateWithGemini, getTranscriptWithGemini } from "./gemini.js";

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

// Seconds of audio downloaded per segment (1s overlap with next)
const SEGMENT_DURATION = 60;

// Video advances this many seconds before switching segments (1s overlap)
const SEGMENT_STRIDE = 59;

// ── Smart Speed Constants ──────────────────────────────────────────────────
const MIN_ATEMPO = 1.0;
// Cap TTS speed at 1.7× for natural-sounding Arabic speech.
// If TTS is still too long at 1.7×, the video is slowed to compensate.
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
 * Build a chained atempo filter string for ffmpeg.
 * Single atempo filter supports 0.5–2.0.
 * For speeds > 2.0 we chain two filters.
 */
function buildAtempoChain(speed: number): string {
  if (speed <= 2.0) {
    return `atempo=${speed.toFixed(4)}`;
  } else if (speed <= 4.0) {
    const second = speed / 2.0;
    return `atempo=2.0,atempo=${second.toFixed(4)}`;
  } else {
    const third = speed / 4.0;
    return `atempo=2.0,atempo=2.0,atempo=${third.toFixed(4)}`;
  }
}

async function applyAtempo(inputPath: string, outputPath: string, speed: number): Promise<void> {
  const filterChain = buildAtempoChain(speed);
  await execFileAsync("ffmpeg", [
    "-i", inputPath,
    "-filter:a", filterChain,
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

// ── Step 1: Download audio segment via yt-dlp ─────────────────────────────
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

// ── Step 2: Transcribe audio with Whisper (base model) ────────────────────
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

export async function processVideoSegment(options: ProcessOptions): Promise<void> {
  const { jobId, videoUrl, startTime, voice } = options;

  let audioInputPath = "";
  let naturalPath = "";
  let audioOutputPath = "";

  try {
    const cookiesAvailable = await hasCookies();
    const cookiesArgs = cookiesAvailable ? ["--cookies", getCookiesPath()] : [];
    const safeUrl = cleanYouTubeUrl(videoUrl);

    const tmpDir = await mkdtemp(join(tmpdir(), "vt-"));
    audioInputPath  = join(tmpDir, `${jobId}-input.mp3`);
    naturalPath     = join(tmpDir, `${jobId}-natural.mp3`);
    audioOutputPath = join(tmpDir, `${jobId}-output.mp3`);

    logger.info({ jobId, startTime }, "Starting video processing");

    // ── Step 1: Download audio via yt-dlp (primary) ───────────────────────
    updateJob(jobId, { status: "processing", progress: "⬇️ تنزيل الصوت من يوتيوب..." });

    let transcript = "";
    let audioDownloaded = false;

    try {
      await downloadAudioSegment(safeUrl, startTime, audioInputPath, cookiesArgs);
      audioDownloaded = existsSync(audioInputPath);
    } catch (e: any) {
      logger.warn({ jobId, err: e?.message }, "yt-dlp audio download failed — will use Gemini transcript");
    }

    // ── Step 2: Transcribe with Whisper (base model) ───────────────────────
    if (audioDownloaded) {
      updateJob(jobId, { progress: "🎙️ تحويل الصوت إلى نص (Whisper base)..." });
      logger.info({ jobId }, "Transcribing audio with Whisper base model");
      transcript = await transcribeWithWhisper(audioInputPath);
      logger.info({ jobId, chars: transcript.length, method: "whisper" }, "Transcript ready");
    }

    // ── Step 2b: Gemini transcript fallback if yt-dlp failed ──────────────
    if (!transcript || transcript.trim().length < 3) {
      updateJob(jobId, { progress: "🤖 استخراج النص عبر Gemini AI..." });
      logger.info({ jobId }, "Falling back to Gemini transcript");
      try {
        transcript = await getTranscriptWithGemini(safeUrl, startTime, SEGMENT_DURATION);
        logger.info({ jobId, chars: transcript.length, method: "gemini" }, "Transcript ready via Gemini");
      } catch (e: any) {
        logger.warn({ jobId, err: e?.message }, "Gemini transcript also failed");
      }
    }

    if (!transcript || transcript.trim().length < 3) {
      throw new Error("لم يتم اكتشاف كلام في هذا المقطع");
    }

    // ── Step 3: Translate to Arabic via Gemini ─────────────────────────────
    updateJob(jobId, { transcript, progress: "🌍 ترجمة إلى العربية عبر Gemini..." });
    logger.info({ jobId, transcript: transcript.slice(0, 100) }, "Translating");

    const prevTranslation = lastTranslationByUrl.get(safeUrl) ?? "";
    const { translation, cleanText } = await translateWithGemini(transcript, prevTranslation, safeUrl, startTime);
    lastTranslationByUrl.set(safeUrl, cleanText.slice(-300));

    if (!cleanText.trim()) throw new Error("فشلت الترجمة: نتيجة فارغة");

    // ── Step 4: TTS at natural rate ────────────────────────────────────────
    updateJob(jobId, { translation, progress: "🔊 توليد الصوت العربي (TTS)..." });
    logger.info({ jobId }, "Generating TTS");

    await synthesizeEdgeTTS(cleanText, voice, 1.0, naturalPath);

    if (!existsSync(naturalPath)) {
      throw new Error("فشل توليد الصوت");
    }

    // ── Step 5: Smart speed calculation ───────────────────────────────────
    //
    // Strategy:
    //   1. requiredSpeed = naturalDuration / SEGMENT_STRIDE
    //   2. Clamp ttsSpeed to [1.0, 1.7] — keeps speech natural
    //   3. adjustedDuration = naturalDuration / ttsSpeed
    //   4. videoSlowdown = SEGMENT_STRIDE / adjustedDuration
    //      → video slows when ttsSpeed was capped (translation too long)
    //
    const naturalDuration  = await getAudioDuration(naturalPath);
    const requiredSpeed    = naturalDuration / SEGMENT_STRIDE;
    const ttsSpeed         = Math.min(Math.max(requiredSpeed, MIN_ATEMPO), MAX_ATEMPO);
    const adjustedDuration = naturalDuration / ttsSpeed;
    const videoSlowdown    = SEGMENT_STRIDE / adjustedDuration;

    logger.info(
      {
        jobId,
        naturalDuration: naturalDuration.toFixed(2),
        requiredSpeed: requiredSpeed.toFixed(3),
        ttsSpeed: ttsSpeed.toFixed(3),
        adjustedDuration: adjustedDuration.toFixed(2),
        videoSlowdown: videoSlowdown.toFixed(3),
      },
      "Smart speed calculated"
    );

    updateJob(jobId, { progress: "⚙️ ضبط سرعة الصوت الذكية..." });

    // ── Step 6: Apply atempo via ffmpeg ────────────────────────────────────
    if (ttsSpeed > 1.02) {
      await applyAtempo(naturalPath, audioOutputPath, ttsSpeed);
    } else {
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
    logger.info({ jobId, ttsSpeed: ttsSpeed.toFixed(3) }, "Processing complete");

  } catch (err: any) {
    const msg = err?.message || "خطأ غير معروف";
    logger.error({ jobId, err: msg }, "Processing failed");
    updateJob(jobId, {
      status: "failed",
      progress: `❌ خطأ: ${msg}`,
      error: msg,
    });
  } finally {
    for (const p of [audioInputPath, naturalPath]) {
      try { if (p && existsSync(p)) await unlink(p); } catch { /* ignore */ }
    }
  }
}
