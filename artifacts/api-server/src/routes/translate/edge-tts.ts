import { execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { logger } from "../../lib/logger.js";

const execFileAsync = promisify(execFile);

const PYTHON = "/home/runner/workspace/.pythonlibs/bin/python3";
const TTS_SERVER_SCRIPT = join(process.cwd(), "tts_server.py");
const TTS_PORT = 19998;
const TTS_BASE = `http://127.0.0.1:${TTS_PORT}`;

let _serverProc: ChildProcess | null = null;
let _serverReady = false;
let _startPromise: Promise<void> | null = null;

async function waitReady(ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${TTS_BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) { _serverReady = true; return; }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("TTS server failed to start in time");
}

function startServer(): Promise<void> {
  if (_startPromise) return _startPromise;
  _startPromise = (async () => {
    if (_serverReady) return;
    logger.info("Starting persistent TTS server...");
    _serverProc = execFile(PYTHON, [TTS_SERVER_SCRIPT], {
      env: { ...process.env, TTS_SERVER_PORT: String(TTS_PORT) },
    });
    _serverProc.stdout?.on("data", d => logger.info({ src: "tts_server" }, d.toString().trim()));
    _serverProc.stderr?.on("data", d => logger.warn({ src: "tts_server" }, d.toString().trim()));
    _serverProc.on("exit", () => {
      logger.warn("TTS server exited — will restart on next request");
      _serverReady = false; _serverProc = null; _startPromise = null;
    });
    await waitReady();
    logger.info("TTS server ready ✅");
  })();
  return _startPromise;
}

const OPENAI_FM_VOICE_IDS = new Set([
  "alloy", "ash", "ballad", "coral", "echo",
  "fable", "nova", "onyx", "sage", "shimmer", "verse",
]);

/**
 * Synthesize text — routes to openai.fm or Edge TTS based on voice ID.
 */
export async function synthesizeEdgeTTS(
  text: string,
  voice: string,
  speed: number,
  outputPath: string
): Promise<void> {
  // openai.fm voices use the /synthesize-openai endpoint
  if (OPENAI_FM_VOICE_IDS.has(voice.toLowerCase())) {
    return synthesizeOpenAIFM(text, voice, outputPath);
  }
  return synthesizeEdgeTTSVoice(text, voice, speed, outputPath);
}

// Fallback Edge TTS voice when openai.fm is blocked (e.g. rate-limited from cloud IPs)
const OPENAI_FM_FALLBACK_VOICE = "ar-SA-HamedNeural";

/**
 * OpenAI.fm TTS synthesis (GPT-4o mini: alloy, ash, ballad, coral, echo…)
 * Falls back to an Arabic Edge TTS voice if openai.fm is blocked (429/502).
 */
async function synthesizeOpenAIFM(
  text: string,
  voice: string,
  outputPath: string
): Promise<void> {
  try {
    if (!_serverReady) await startServer();

    const res = await fetch(`${TTS_BASE}/synthesize-openai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: voice.toLowerCase() }),
      signal: AbortSignal.timeout(90_000),
    });

    if (res.ok) {
      const audioBuffer = await res.arrayBuffer();
      await writeFile(outputPath, Buffer.from(audioBuffer));
      return;
    }

    const status = res.status;
    const err = await res.json().catch(() => ({ error: `HTTP ${status}` })) as { error?: string };

    // 429 = rate limited / blocked from this IP, 502 = upstream blocked
    // Fall back silently to Edge TTS so the pipeline never breaks
    if (status === 429 || status === 502) {
      logger.warn({ voice, status }, "openai.fm blocked/rate-limited — falling back to Edge TTS");
      return synthesizeEdgeTTSVoice(text, OPENAI_FM_FALLBACK_VOICE, 1.0, outputPath);
    }

    throw new Error(err.error || `OpenAI.fm TTS: ${status}`);
  } catch (e: any) {
    // Network error — fall back to Edge TTS
    logger.warn({ err: e?.message }, "OpenAI.fm TTS failed — falling back to Edge TTS");
    return synthesizeEdgeTTSVoice(text, OPENAI_FM_FALLBACK_VOICE, 1.0, outputPath);
  }
}

/**
 * Synthesize text using the persistent Edge TTS server (edge_tts Python module).
 * Falls back to CLI subprocess if server fails.
 */
async function synthesizeEdgeTTSVoice(
  text: string,
  voice: string,
  speed: number,
  outputPath: string
): Promise<void> {
  const ratePercent = Math.round((speed - 1.0) * 100);
  const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;

  // Try persistent server first
  try {
    if (!_serverReady) await startServer();

    const res = await fetch(`${TTS_BASE}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, rate: rateStr }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error || `TTS server: ${res.status}`);
    }

    const audioBuffer = await res.arrayBuffer();
    await writeFile(outputPath, Buffer.from(audioBuffer));
    return;
  } catch (e: any) {
    logger.warn({ err: e?.message }, "TTS server failed, falling back to CLI");
    _serverReady = false; _serverProc = null; _startPromise = null;
  }

  // Fallback: CLI subprocess
  const bin = getCLIBin();
  await execFileAsync(bin, [
    "--voice", voice,
    "--rate", rateStr,
    "--text", text,
    "--write-media", outputPath,
  ], { timeout: 90_000, maxBuffer: 50 * 1024 * 1024 });
}

function getCLIBin(): string {
  const candidates = [
    "/home/runner/workspace/.pythonlibs/bin/edge-tts",
    join(process.cwd(), ".pythonlibs", "bin", "edge-tts"),
    join(process.cwd(), ".venv", "bin", "edge-tts"),
    "/home/runner/workspace/.venv/bin/edge-tts",
    "edge-tts",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "/home/runner/workspace/.pythonlibs/bin/edge-tts";
}

export const EDGE_TTS_VOICES = [
  // ── OpenAI.fm voices (GPT-4o mini TTS) ───────────────────────────────────
  { id: "alloy",   name: "🤖 Alloy - OpenAI (متوازن)", lang: "en-US" },
  { id: "ash",     name: "🤖 Ash - OpenAI (واضح)", lang: "en-US" },
  { id: "ballad",  name: "🤖 Ballad - OpenAI (موسيقي)", lang: "en-US" },
  { id: "coral",   name: "🤖 Coral - OpenAI (ودود)", lang: "en-US" },
  { id: "echo",    name: "🤖 Echo - OpenAI (رسمي)", lang: "en-US" },
  { id: "fable",   name: "🤖 Fable - OpenAI (قصصي)", lang: "en-US" },
  { id: "nova",    name: "🤖 Nova - OpenAI (نشيط)", lang: "en-US" },
  { id: "onyx",    name: "🤖 Onyx - OpenAI (عميق)", lang: "en-US" },
  { id: "sage",    name: "🤖 Sage - OpenAI (هادئ)", lang: "en-US" },
  { id: "shimmer", name: "🤖 Shimmer - OpenAI (ناعم)", lang: "en-US" },
  { id: "verse",   name: "🤖 Verse - OpenAI (معبّر)", lang: "en-US" },
  // ── Microsoft Edge TTS voices ──────────────────────────────────────────
  { id: "fr-FR-RemyMultilingualNeural", name: "🇫🇷 Remy - متعدد اللغات", lang: "fr-FR" },
  { id: "ar-SA-HamedNeural", name: "🇸🇦 حامد - السعودية", lang: "ar-SA" },
  { id: "ar-SA-ZariyahNeural", name: "🇸🇦 ذرية - السعودية", lang: "ar-SA" },
  { id: "ar-EG-ShakirNeural", name: "🇪🇬 شاكر - مصر", lang: "ar-EG" },
  { id: "ar-EG-SalmaNeural", name: "🇪🇬 سلمى - مصر", lang: "ar-EG" },
  { id: "ar-IQ-BasselNeural", name: "🇮🇶 باسل - العراق", lang: "ar-IQ" },
  { id: "ar-IQ-RanaNeural", name: "🇮🇶 رنا - العراق", lang: "ar-IQ" },
  { id: "ar-KW-FahedNeural", name: "🇰🇼 فهد - الكويت", lang: "ar-KW" },
  { id: "ar-KW-NouraNeural", name: "🇰🇼 نورا - الكويت", lang: "ar-KW" },
  { id: "en-US-JennyMultilingualNeural", name: "🌍 Jenny - متعدد اللغات", lang: "en-US" },
  { id: "en-US-RyanMultilingualNeural", name: "🌍 Ryan - متعدد اللغات", lang: "en-US" },
];
