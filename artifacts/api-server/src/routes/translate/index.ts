import { Router, type IRouter } from "express";
import { createReadStream, existsSync } from "fs";
import { ProcessVideoBody, GetJobStatusParams, GetAudioParams } from "@workspace/api-zod";
import { createJob, getJob } from "./jobs.js";
import { processVideoSegment, getAudioPath, TTS_VOICES } from "./processor.js";
import {
  saveCookies, deleteCookies, hasCookies, getDetailedCookiesStatus, validateGeminiCookies,
} from "./cookies.js";

const router: IRouter = Router();

router.get("/translate/models", (_req, res) => {
  res.json({ voices: TTS_VOICES });
});

// ── Cookies management ────────────────────────────────────────────────────────

router.get("/translate/cookies/status", async (_req, res) => {
  const status = await getDetailedCookiesStatus();
  res.json(status);
});

router.post("/translate/cookies", async (req, res) => {
  const { cookies } = req.body as { cookies?: string };
  if (!cookies || typeof cookies !== "string" || cookies.trim().length < 10) {
    res.status(400).json({ error: "يرجى تقديم محتوى الكوكيز" });
    return;
  }
  try {
    await saveCookies(cookies.trim());
    const status = await getDetailedCookiesStatus();
    res.json({ success: true, message: "تم حفظ الكوكيز ✅", status });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "فشل حفظ الكوكيز" });
  }
});

router.delete("/translate/cookies", async (_req, res) => {
  await deleteCookies();
  res.json({ success: true, message: "تم حذف الكوكيز" });
});

router.post("/translate/cookies/validate", async (_req, res) => {
  const quick = await getDetailedCookiesStatus();
  if (quick.status === "invalid" || quick.status === "incomplete") {
    res.json({ valid: false, message: quick.message });
    return;
  }
  const result = await validateGeminiCookies();
  res.json(result);
});

// ── Video processing ──────────────────────────────────────────────────────────

router.post("/translate/process", async (req, res) => {
  const parsed = ProcessVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const { videoUrl, startTime, voice, translationEngine, forceAudioExtraction } = parsed.data;
  const job = createJob(startTime);

  processVideoSegment({
    jobId: job.jobId,
    videoUrl,
    startTime,
    voice,
    translationEngine: translationEngine as any,
    forceAudioExtraction,
  }).catch(() => {});

  res.json({ jobId: job.jobId, status: job.status, message: "بدأت المعالجة" });
});

router.get("/translate/status/:jobId", (req, res) => {
  const parsed = GetJobStatusParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const job = getJob(parsed.data.jobId);
  if (!job) {
    res.status(404).json({ error: "not_found", message: "المهمة غير موجودة" });
    return;
  }

  res.json({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    audioUrl: job.status === "completed" ? `/api/translate/audio/${job.jobId}` : null,
    transcript: job.transcript,
    translation: job.translation,
    error: job.error,
    startTime: job.startTime,
    suggestedRate: job.suggestedRate,
    videoSlowdown: job.videoSlowdown,
  });
});

router.get("/translate/audio/:jobId", (req, res) => {
  const parsed = GetAudioParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", message: parsed.error.message });
    return;
  }

  const audioPath = getAudioPath(parsed.data.jobId);
  if (!audioPath || !existsSync(audioPath)) {
    res.status(404).json({ error: "not_found", message: "الصوت غير متوفر" });
    return;
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-cache");
  createReadStream(audioPath).pipe(res);
});

export default router;
