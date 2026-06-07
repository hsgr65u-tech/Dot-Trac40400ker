import { execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { logger } from "../../lib/logger.js";

const execFileAsync = promisify(execFile);

const PYTHON = "/home/runner/workspace/.pythonlibs/bin/python3";
const SERVER_SCRIPT = join(process.cwd(), "gemini_server.py");
const PORT = 19999;
const BASE = `http://127.0.0.1:${PORT}`;

let _serverProc: ChildProcess | null = null;
let _serverReady = false;
let _startPromise: Promise<void> | null = null;

async function waitReady(ms = 40_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) { _serverReady = true; return; }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 800));
  }
  throw new Error("Gemini server failed to start in time");
}

function startServer(): Promise<void> {
  if (_startPromise) return _startPromise;
  _startPromise = (async () => {
    if (_serverReady) return;
    logger.info("Starting persistent Gemini server...");
    _serverProc = execFile(PYTHON, [SERVER_SCRIPT], {
      env: { ...process.env, GEMINI_SERVER_PORT: String(PORT) },
    });
    _serverProc.stdout?.on("data", d => logger.info({ src: "gemini_server" }, d.toString().trim()));
    _serverProc.stderr?.on("data", d => logger.warn({ src: "gemini_server" }, d.toString().trim()));
    _serverProc.on("exit", () => {
      logger.warn("Gemini server exited — will restart on next request");
      _serverReady = false; _serverProc = null; _startPromise = null;
    });
    await waitReady();
    logger.info("Gemini server ready ✅");
  })();
  return _startPromise;
}

export async function reloadGeminiServer(): Promise<void> {
  if (!_serverReady) { await startServer(); return; }
  try {
    await fetch(`${BASE}/reload`, { method: "POST", signal: AbortSignal.timeout(40_000) });
  } catch { /* ignore reload errors */ }
}

/**
 * Use Gemini to directly transcribe a YouTube video segment.
 * Bypasses yt-dlp entirely — Gemini accesses the video natively.
 */
export async function getTranscriptWithGemini(
  videoUrl: string,
  startTime: number,
  duration: number,
): Promise<string> {
  if (!_serverReady) await startServer();

  const res = await fetch(`${BASE}/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: videoUrl, start: startTime, duration }),
    signal: AbortSignal.timeout(120_000),
  });

  const data = await res.json() as { transcript?: string; empty?: boolean; error?: string };
  if (data.error) throw new Error(data.error);
  if (data.empty) return "";
  return data.transcript ?? "";
}

export interface TranslationResult {
  /** Full Arabic text with [HH:MM:SS] timestamps — for display/subtitles */
  translation: string;
  /** Timestamps stripped — clean Arabic text for TTS */
  cleanText: string;
}

export async function translateWithGemini(
  text: string,
  context?: string,
  videoUrl?: string,
  startTime?: number,
): Promise<TranslationResult> {
  if (!_serverReady) await startServer();

  const res = await fetch(`${BASE}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      context: context ?? "",
      videoUrl: videoUrl ?? "",
      startTime: startTime ?? 0,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const data = await res.json() as { translation?: string; cleanText?: string; error?: string };
  if (data.error) throw new Error(data.error);
  if (!data.translation) throw new Error("نتيجة فارغة من Gemini");

  const translation = data.translation;
  // If backend didn't return cleanText (older server), strip timestamps client-side
  const cleanText = data.cleanText ?? translation.replace(/\[\d{2}:\d{2}:\d{2}\]\s*/g, " ").replace(/\s+/g, " ").trim();

  return { translation, cleanText };
}
