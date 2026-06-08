import React, { useState, useRef, useEffect, useCallback } from 'react';
import YouTube from 'react-youtube';
import { Play, Square, Youtube, Volume2, Loader2, Cookie, ChevronDown, ChevronUp, Trash2, Globe, ChevronLeft, ChevronRight, ShieldCheck, ShieldX, ShieldAlert, RotateCcw, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { useToast } from '@/hooks/use-toast';
import { useGetTtsModels } from '@workspace/api-client-react';
import { useYoutubeUrl } from '@/hooks/use-youtube-url';
import { PipelineBar } from '@/components/pipeline-bar';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const SEGMENT_STRIDE = 59;
const SEGMENT_WINDOW = 60;
const POLL_MS = 800;
const MAX_RETRIES = 2;
const DRIFT_COOLDOWN_MS = 5000;

type TranslationEngine = 'openai' | 'google' | 'pollinations';

interface SegJob {
  jobId: string;
  status: 'processing' | 'completed' | 'failed';
  audioUrl: string | null;
  suggestedRate: number;
  videoSlowdown: number;
  progress: string;
  translation?: string;
}

interface CookieStatus {
  status: 'working' | 'expired' | 'invalid' | 'incomplete' | 'unchecked';
  hasPSID: boolean;
  hasPSIDTS: boolean;
  hasYouTube: boolean;
  hasGemini: boolean;
  message: string;
}

interface GeminiValidation {
  valid: boolean;
  message: string;
  hasPSID?: boolean;
  hasPSIDTS?: boolean;
  testResponse?: string;
  error?: string;
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function segLabel(k: number) { return `${fmt(k)} – ${fmt(k + SEGMENT_WINDOW)}`; }

async function postProcess(videoUrl: string, startTime: number, voice: string, translationEngine: TranslationEngine) {
  const r = await fetch('/api/translate/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoUrl, startTime, voice, translationEngine }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'فشل الطلب');
  return d.jobId as string;
}

async function fetchStatus(jobId: string) {
  const r = await fetch(`/api/translate/status/${jobId}`);
  return r.json();
}

async function fetchCookieStatus(): Promise<CookieStatus> {
  try {
    const r = await fetch('/api/translate/cookies/status');
    return await r.json();
  } catch {
    return { status: 'invalid', hasPSID: false, hasPSIDTS: false, hasYouTube: false, hasGemini: false, message: 'فشل الاتصال' };
  }
}

async function postCookies(content: string): Promise<{ success: boolean; message: string; status?: CookieStatus }> {
  const r = await fetch('/api/translate/cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies: content }),
  });
  const d = await r.json();
  if (!r.ok) return { success: false, message: d.error || 'فشل الحفظ' };
  return { success: true, message: d.message, status: d.status };
}

async function validateCookies(): Promise<GeminiValidation> {
  try {
    const r = await fetch('/api/translate/cookies/validate', { method: 'POST' });
    return await r.json();
  } catch {
    return { valid: false, message: 'فشل الاتصال بالخادم' };
  }
}

async function deleteCookiesReq() {
  await fetch('/api/translate/cookies', { method: 'DELETE' });
}

export default function Home() {
  const { toast } = useToast();
  const { url, setUrl, videoId, isValid } = useYoutubeUrl();

  const ytRef = useRef<any>(null);

  // ── Dual audio elements for gapless playback ────────────────────────────
  const audioARef = useRef<HTMLAudioElement>(null);
  const audioBRef = useRef<HTMLAudioElement>(null);
  const activeSlotRef = useRef<'a' | 'b'>('a');
  const standbyUrlRef = useRef<string>('');
  const standbyReadyRef = useRef(false);

  const getActiveAudio  = () => activeSlotRef.current === 'a' ? audioARef.current : audioBRef.current;
  const getStandbyAudio = () => activeSlotRef.current === 'a' ? audioBRef.current : audioARef.current;
  const swapSlot        = () => { activeSlotRef.current = activeSlotRef.current === 'a' ? 'b' : 'a'; };

  const jobsRef = useRef<Map<number, SegJob>>(new Map());
  const activeSegRef = useRef<number>(-1);
  const isRunningRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const playingSegRef = useRef<number>(-1);
  const finishedSegRef = useRef<number>(-1);
  const waitingRef = useRef(false);
  const kickCountRef = useRef<Map<number, number>>(new Map());
  const lastRetryRef = useRef<Map<number, number>>(new Map());
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segPlayStartMsRef = useRef<number>(0);

  // ── Manual sync offset (seconds) ─────────────────────────────────────────
  // Positive = audio plays later (audio jumps forward / delayed behind video)
  // Negative = audio plays earlier (audio jumps back / ahead of video)
  const syncOffsetRef = useRef<number>(0);
  const [syncOffset, setSyncOffset] = useState<number>(0);

  const [jobs, setJobs] = useState<Map<number, SegJob>>(new Map());
  const [activeSeg, setActiveSeg] = useState<number>(-1);
  const [processingProgress, setProcessingProgress] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [ytReady, setYtReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [selectedVoice, setSelectedVoice] = useState('');
  const [selectedEngine] = useState<TranslationEngine>('openai');
  const [hasStarted, setHasStarted] = useState(false);
  const [isWaitingForProcess, setIsWaitingForProcess] = useState(false);
  const [currentSentence, setCurrentSentence] = useState('');

  const [showCookies, setShowCookies] = useState(false);
  const [cookieText, setCookieText] = useState('');
  const [cookieStatus, setCookieStatus] = useState<CookieStatus | null>(null);
  const [cookieSaving, setCookieSaving] = useState(false);
  const [geminiValidation, setGeminiValidation] = useState<GeminiValidation | null>(null);
  const [geminiChecking, setGeminiChecking] = useState(false);

  const { data: modelsData } = useGetTtsModels();

  useEffect(() => {
    fetchCookieStatus().then(setCookieStatus);
  }, []);

  useEffect(() => {
    if (modelsData?.voices?.length && !selectedVoice) {
      setSelectedVoice(modelsData.voices[0].id);
    }
  }, [modelsData, selectedVoice]);

  const syncJobs = useCallback(() => setJobs(new Map(jobsRef.current)), []);

  const pollJob = useCallback(async (seg: number, jobId: string) => {
    let consecutiveErrors = 0;
    while (true) {
      await new Promise(r => setTimeout(r, POLL_MS));
      try {
        const status = await fetchStatus(jobId);
        consecutiveErrors = 0;
        jobsRef.current.set(seg, {
          jobId, status: status.status, audioUrl: status.audioUrl,
          suggestedRate: status.suggestedRate ?? 1.0,
          videoSlowdown: status.videoSlowdown ?? 1.0,
          progress: status.progress, translation: status.translation,
        });
        syncJobs();
        if (seg === activeSegRef.current) setProcessingProgress(status.progress || '');
        if (status.status === 'completed' || status.status === 'failed') break;
      } catch {
        consecutiveErrors++;
        if (consecutiveErrors >= 3) {
          const current = jobsRef.current.get(seg);
          if (current && current.status === 'processing') {
            jobsRef.current.set(seg, { ...current, status: 'failed', progress: '❌ انقطع الاتصال بالخادم' });
            syncJobs();
          }
          break;
        }
      }
    }
  }, [syncJobs]);

  const startSegJob = useCallback(async (seg: number, force = false) => {
    const count = kickCountRef.current.get(seg) ?? 0;
    if (!force && count > 0) return;
    if (count >= MAX_RETRIES + 1) return;
    kickCountRef.current.set(seg, count + 1);
    lastRetryRef.current.set(seg, Date.now());
    jobsRef.current.set(seg, { jobId: '', status: 'processing', audioUrl: null, suggestedRate: 1.0, videoSlowdown: 1.0, progress: '⏳ جاري التحضير...' });
    syncJobs();
    try {
      const jobId = await postProcess(url, seg, selectedVoice, selectedEngine);
      const entry = jobsRef.current.get(seg);
      if (entry) { entry.jobId = jobId; jobsRef.current.set(seg, entry); }
      pollJob(seg, jobId);
    } catch {
      jobsRef.current.set(seg, { jobId: '', status: 'failed', audioUrl: null, suggestedRate: 1.0, videoSlowdown: 1.0, progress: '❌ فشل الاتصال بالخادم' });
      syncJobs();
    }
  }, [url, selectedVoice, selectedEngine, pollJob, syncJobs]);

  // ── Smart sync: apply video rate + seek audio accounting for manual offset ──
  const applySyncRates = useCallback((audio: HTMLAudioElement) => {
    if (!audio.duration || audio.duration <= 0) return;

    audio.playbackRate = 1.0;

    const rawRate = SEGMENT_STRIDE / audio.duration;
    const videoRate = Math.min(Math.max(rawRate, 0.25), 2.0);
    if (ytRef.current) ytRef.current.setPlaybackRate(videoRate);

    const seg = playingSegRef.current;
    if (seg >= 0 && ytRef.current) {
      const videoPos = ytRef.current.getCurrentTime() ?? 0;
      const videoOffsetInSeg = Math.max(0, videoPos - seg);
      // Apply manual sync offset: positive offset = audio should be further ahead
      const baseSeek = (videoOffsetInSeg / SEGMENT_STRIDE) * audio.duration;
      const seekPos = Math.min(
        Math.max(baseSeek + syncOffsetRef.current, 0),
        audio.duration - 0.3
      );
      if (seekPos > 2.5) {
        audio.currentTime = seekPos;
      }
    }
  }, []);

  // ── Drift correction: periodic re-alignment with manual offset ───────────
  const syncAudioToVideo = useCallback(() => {
    const audioEl = getActiveAudio();
    if (!audioEl || audioEl.paused || audioEl.ended || !audioEl.duration || audioEl.duration <= 0) return;

    const seg = playingSegRef.current;
    if (seg < 0 || !ytRef.current) return;

    if (Date.now() - segPlayStartMsRef.current < DRIFT_COOLDOWN_MS) return;

    const videoPos = ytRef.current.getCurrentTime() ?? 0;
    const videoOffsetInSeg = Math.max(0, videoPos - seg);
    // Target position includes the manual sync offset
    const expectedAudioPos = (videoOffsetInSeg / SEGMENT_STRIDE) * audioEl.duration + syncOffsetRef.current;

    if (expectedAudioPos >= audioEl.duration - 0.3) return;

    const drift = audioEl.currentTime - expectedAudioPos;

    // Only correct forward drift (audio behind video) to avoid backward jumps
    if (drift < -3.0) {
      audioEl.currentTime = Math.min(expectedAudioPos, audioEl.duration - 0.3);
    }
  }, []);

  // ── Manual sync adjustment ─────────────────────────────────────────────
  const adjustSync = useCallback((delta: number) => {
    const audioEl = getActiveAudio();
    syncOffsetRef.current += delta;
    setSyncOffset(syncOffsetRef.current);
    // Apply immediately to playing audio
    if (audioEl && !audioEl.paused && !audioEl.ended && audioEl.duration > 0) {
      const newTime = Math.min(
        Math.max(audioEl.currentTime + delta, 0),
        audioEl.duration - 0.1
      );
      audioEl.currentTime = newTime;
    }
  }, []);

  const resetSync = useCallback(() => {
    syncOffsetRef.current = 0;
    setSyncOffset(0);
    // Seek audio back to correct position
    const audioEl = getActiveAudio();
    const seg = playingSegRef.current;
    if (audioEl && !audioEl.paused && !audioEl.ended && audioEl.duration > 0 && seg >= 0 && ytRef.current) {
      const videoPos = ytRef.current.getCurrentTime() ?? 0;
      const videoOffsetInSeg = Math.max(0, videoPos - seg);
      const target = Math.min((videoOffsetInSeg / SEGMENT_STRIDE) * audioEl.duration, audioEl.duration - 0.3);
      audioEl.currentTime = Math.max(target, 0);
    }
  }, []);

  const autoSync = useCallback(() => {
    const audioEl = getActiveAudio();
    const seg = playingSegRef.current;
    if (!audioEl || audioEl.paused || audioEl.ended || !audioEl.duration || seg < 0 || !ytRef.current) return;

    const videoPos = ytRef.current.getCurrentTime() ?? 0;
    const videoOffsetInSeg = Math.max(0, videoPos - seg);
    const expectedAudioPos = (videoOffsetInSeg / SEGMENT_STRIDE) * audioEl.duration;
    const drift = audioEl.currentTime - expectedAudioPos; // positive = audio ahead

    // Apply drift as new offset and seek audio to correct position
    syncOffsetRef.current = drift;
    setSyncOffset(drift);
    audioEl.currentTime = Math.min(Math.max(expectedAudioPos, 0), audioEl.duration - 0.3);
    toast({ title: `مزامنة تلقائية ✅`, description: `تصحيح: ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s` });
  }, [toast]);

  // ── Preload next segment ─────────────────────────────────────────────────
  const preloadNextIntoStandby = useCallback((currentSeg: number) => {
    const nextSeg = currentSeg + SEGMENT_STRIDE;
    const nextJob = jobsRef.current.get(nextSeg);
    if (!nextJob || nextJob.status !== 'completed' || !nextJob.audioUrl) return;

    const standby = getStandbyAudio();
    if (!standby) return;
    if (standbyUrlRef.current === nextJob.audioUrl) return;

    standbyUrlRef.current = nextJob.audioUrl;
    standbyReadyRef.current = false;
    standby.oncanplaythrough = () => { standbyReadyRef.current = true; };
    standby.onloadedmetadata = null;
    standby.onended = null;
    standby.src = nextJob.audioUrl;
    standby.preload = 'auto';
    standby.load();
  }, []);

  // ── Core: play audio for a segment ──────────────────────────────────────
  const playAudioForSeg = useCallback((seg: number, job: SegJob) => {
    if (!job.audioUrl) return;
    if (playingSegRef.current === seg || finishedSegRef.current === seg) return;

    const nextSeg = seg + SEGMENT_STRIDE;

    const standby = getStandbyAudio();
    const isPreloaded =
      standbyReadyRef.current &&
      standbyUrlRef.current === job.audioUrl &&
      standby !== null &&
      standby.readyState >= 2;

    let audioEl: HTMLAudioElement;

    if (isPreloaded) {
      getActiveAudio()?.pause();
      swapSlot();
      audioEl = getActiveAudio()!;
      standbyUrlRef.current = '';
      standbyReadyRef.current = false;
    } else {
      audioEl = getActiveAudio()!;
      if (!audioEl) return;
      standbyUrlRef.current = '';
      standbyReadyRef.current = false;
      audioEl.src = job.audioUrl;
      audioEl.load();
    }

    playingSegRef.current = seg;
    segPlayStartMsRef.current = Date.now();
    setCurrentSentence(job.translation || '');

    audioEl.onloadedmetadata = () => applySyncRates(audioEl);

    audioEl.onended = () => {
      finishedSegRef.current = seg;
      setCurrentSentence('');
      if (ytRef.current) ytRef.current.setPlaybackRate(1.0);
      standbyReadyRef.current = false;

      if (!isRunningRef.current) return;

      const nextJob = jobsRef.current.get(nextSeg);
      if (!nextJob || nextJob.status !== 'completed' || !nextJob.audioUrl) return;

      const sb = getStandbyAudio();
      const canGapless =
        standbyReadyRef.current &&
        standbyUrlRef.current === nextJob.audioUrl &&
        sb !== null &&
        sb.readyState >= 2;

      if (canGapless) {
        getActiveAudio()?.pause();
        swapSlot();
        const nowActive = getActiveAudio()!;
        standbyUrlRef.current = '';
        standbyReadyRef.current = false;
        playingSegRef.current = -1;

        setCurrentSentence(nextJob.translation || '');
        playingSegRef.current = nextSeg;
        segPlayStartMsRef.current = Date.now();

        applySyncRates(nowActive);
        nowActive.onloadedmetadata = () => applySyncRates(nowActive);
        nowActive.onended = () => {
          finishedSegRef.current = nextSeg;
          setCurrentSentence('');
          if (ytRef.current) ytRef.current.setPlaybackRate(1.0);
          standbyReadyRef.current = false;
          playingSegRef.current = -1;
        };
        nowActive.play().catch(() => {});
      } else {
        playingSegRef.current = -1;
        playAudioForSeg(nextSeg, nextJob);
      }

      preloadNextIntoStandby(nextSeg);
    };

    if (audioEl.readyState >= 1 && audioEl.duration > 0) applySyncRates(audioEl);
    audioEl.play().catch(() => {});
    preloadNextIntoStandby(seg);
  }, [applySyncRates, preloadNextIntoStandby]);

  const seekToSegment = (offset: number) => {
    if (!ytRef.current) return;
    const currentTime = ytRef.current.getCurrentTime();
    const newTime = Math.max(0, Math.floor(currentTime / SEGMENT_STRIDE) * SEGMENT_STRIDE + (offset * SEGMENT_STRIDE));
    playingSegRef.current = -1; finishedSegRef.current = -1;
    standbyUrlRef.current = ''; standbyReadyRef.current = false;
    getActiveAudio()?.pause();
    getStandbyAudio()?.pause();
    if (ytRef.current) ytRef.current.setPlaybackRate(1.0);
    ytRef.current.seekTo(newTime, true);
  };

  const startTranslation = useCallback(async () => {
    if (!ytRef.current || !isValid || !selectedVoice) return;
    stopRequestedRef.current = false; isRunningRef.current = true; waitingRef.current = false;
    setIsRunning(true); setHasStarted(true); setIsWaitingForProcess(false);
    jobsRef.current.clear(); kickCountRef.current.clear(); lastRetryRef.current.clear(); syncJobs();
    standbyUrlRef.current = ''; standbyReadyRef.current = false;
    // Reset sync offset on new session
    syncOffsetRef.current = 0; setSyncOffset(0);
    const dur = ytRef.current.getDuration() || duration;

    const runLoop = async () => {
      let lastSyncCheckMs = 0;
      while (!stopRequestedRef.current) {
        const currentTime = ytRef.current?.getCurrentTime() ?? 0;
        const rawSeg = Math.floor(currentTime / SEGMENT_STRIDE) * SEGMENT_STRIDE;
        const audioStillPlaying = playingSegRef.current === activeSegRef.current &&
          (() => { const a = getActiveAudio(); return a && !a.paused && !a.ended && a.currentTime < (a.duration - 0.3); })();
        const seg = (audioStillPlaying && rawSeg > activeSegRef.current) ? activeSegRef.current : rawSeg;
        if (seg !== activeSegRef.current) { activeSegRef.current = seg; setActiveSeg(seg); setProcessingProgress(''); }

        const currentJob = jobsRef.current.get(seg);
        if (!currentJob) { startSegJob(seg); }
        else if (currentJob.status === 'failed') {
          const count = kickCountRef.current.get(seg) ?? 0;
          const lastRetry = lastRetryRef.current.get(seg) ?? 0;
          if (count <= MAX_RETRIES && Date.now() - lastRetry > 5000) startSegJob(seg, true);
        }

        const nextSeg1 = seg + SEGMENT_STRIDE;
        const nextSeg2 = seg + SEGMENT_STRIDE * 2;
        if (nextSeg1 < dur && !kickCountRef.current.has(nextSeg1)) startSegJob(nextSeg1);
        if (nextSeg2 < dur && !kickCountRef.current.has(nextSeg2)) startSegJob(nextSeg2);

        if (playingSegRef.current === seg) preloadNextIntoStandby(seg);

        const freshJob = jobsRef.current.get(seg);
        if (!freshJob || freshJob.status === 'processing') {
          if (!waitingRef.current) { waitingRef.current = true; setIsWaitingForProcess(true); ytRef.current?.pauseVideo(); }
          if (freshJob?.progress) setProcessingProgress(freshJob.progress);
        } else if (freshJob.status === 'completed') {
          if (waitingRef.current) { waitingRef.current = false; setIsWaitingForProcess(false); ytRef.current?.playVideo(); }
          playAudioForSeg(seg, freshJob);
        } else if (freshJob.status === 'failed') {
          const count = kickCountRef.current.get(seg) ?? 0;
          if (count > MAX_RETRIES && waitingRef.current) { waitingRef.current = false; setIsWaitingForProcess(false); ytRef.current?.playVideo(); }
        }

        const nowMs = Date.now();
        if (nowMs - lastSyncCheckMs > 2000 && !waitingRef.current) {
          lastSyncCheckMs = nowMs;
          syncAudioToVideo();
        }

        await new Promise(r => setTimeout(r, 100));
      }
      isRunningRef.current = false; setIsRunning(false); setIsWaitingForProcess(false); waitingRef.current = false;
    };
    runLoop();
  }, [isValid, selectedVoice, url, duration, syncJobs, startSegJob, playAudioForSeg, preloadNextIntoStandby, syncAudioToVideo]);

  const stopTranslation = useCallback(() => {
    stopRequestedRef.current = true; isRunningRef.current = false; waitingRef.current = false;
    setIsRunning(false); setIsWaitingForProcess(false);
    if (ytRef.current) { ytRef.current.pauseVideo(); ytRef.current.setPlaybackRate(1.0); }
    getActiveAudio()?.pause();
    getStandbyAudio()?.pause();
    standbyUrlRef.current = ''; standbyReadyRef.current = false;
    activeSegRef.current = -1; setActiveSeg(-1);
    segPlayStartMsRef.current = 0;
  }, []);

  const handleCookieChange = (text: string) => {
    setCookieText(text);
    setGeminiValidation(null);
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    if (text.trim().length < 20) return;

    saveDebounceRef.current = setTimeout(async () => {
      setCookieSaving(true);
      const result = await postCookies(text.trim());
      setCookieSaving(false);
      if (result.success) {
        if (result.status) setCookieStatus(result.status);
        setCookieText('');
        toast({ title: 'تم حفظ الكوكيز ✅' });
        setGeminiChecking(true);
        const validation = await validateCookies();
        setGeminiChecking(false);
        setGeminiValidation(validation);
      } else {
        toast({ title: 'خطأ', description: result.message, variant: 'destructive' });
      }
    }, 800);
  };

  const handleValidateNow = async () => {
    setGeminiChecking(true);
    setGeminiValidation(null);
    const validation = await validateCookies();
    setGeminiChecking(false);
    setGeminiValidation(validation);
  };

  const handleDeleteCookies = async () => {
    await deleteCookiesReq();
    setCookieStatus(null);
    setGeminiValidation(null);
    setCookieText('');
    toast({ title: 'تم حذف الكوكيز' });
  };

  const hasSavedCookies = cookieStatus && cookieStatus.status !== 'invalid' && cookieStatus.hasPSID;
  const activeJob = activeSeg >= 0 ? jobs.get(activeSeg) : undefined;

  const CookieStatusIcon = () => {
    if (!hasSavedCookies) return <ShieldX className="w-4 h-4 text-red-400" />;
    if (geminiValidation?.valid) return <ShieldCheck className="w-4 h-4 text-emerald-400" />;
    if (geminiValidation && !geminiValidation.valid) return <ShieldX className="w-4 h-4 text-red-400" />;
    return <ShieldAlert className="w-4 h-4 text-amber-400" />;
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6 flex flex-col items-center" dir="rtl">
      <div className="w-full max-w-2xl space-y-4">

        {/* Header */}
        <div className="text-center pt-4 pb-2">
          <div className="flex items-center justify-center gap-2 mb-1">
            <Youtube className="w-6 h-6 text-red-500" />
            <h1 className="text-2xl font-bold text-white">مترجم الفيديو</h1>
          </div>
          <p className="text-slate-400 text-sm">ترجمة فورية لمقاطع يوتيوب إلى العربية عبر Gemini AI</p>
        </div>

        {/* Settings Card */}
        <Card className="bg-slate-900/50 border-slate-800/60 p-4 space-y-3">
          <div className="space-y-2">
            <label className="text-xs text-slate-400 font-medium">رابط يوتيوب</label>
            <Input
              placeholder="https://youtube.com/watch?v=..."
              value={url}
              onChange={e => setUrl(e.target.value)}
              className="bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500 text-left"
              dir="ltr"
            />
          </div>

          {/* Voice Selection */}
          <div className="space-y-2">
            <label className="text-xs text-slate-400 font-medium flex items-center gap-1.5">
              <Volume2 className="w-3.5 h-3.5" />
              الصوت العربي
            </label>
            <Select value={selectedVoice} onValueChange={setSelectedVoice}>
              <SelectTrigger className="bg-slate-800 border-slate-700 text-slate-100">
                <SelectValue placeholder="اختر الصوت..." />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                {modelsData?.voices?.map((v: { id: string; name: string }) => (
                  <SelectItem key={v.id} value={v.id} className="text-slate-100 focus:bg-slate-700">{v.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Card>

        {/* YouTube Player */}
        {isValid && (
          <Card className="bg-slate-900/50 border-slate-800/60 overflow-hidden">
            <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
              <div className="absolute inset-0">
                <YouTube
                  videoId={videoId!}
                  onReady={e => { ytRef.current = e.target; setYtReady(true); const d = e.target.getDuration(); if (d > 0) setDuration(d); }}
                  onStateChange={e => {
                    const YT = (window as any).YT;
                    if (!YT) return;
                    const active = getActiveAudio();
                    if (e.data === YT.PlayerState.ENDED) {
                      active?.pause();
                      getStandbyAudio()?.pause();
                    } else if (e.data === YT.PlayerState.PAUSED) {
                      if (active && !active.paused) active.pause();
                    } else if (e.data === YT.PlayerState.PLAYING) {
                      if (active?.src && active.paused && !active.ended) active.play().catch(() => {});
                    }
                  }}
                  opts={{ width: '100%', height: '100%', playerVars: { autoplay: 0, controls: 1, rel: 0 } }}
                  className="w-full h-full"
                />
              </div>
              <AnimatePresence>
                {isWaitingForProcess && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm z-10">
                    <div className="flex flex-col items-center gap-3 text-center px-6">
                      <div className="relative">
                        <div className="w-14 h-14 rounded-full border-4 border-violet-500/30 border-t-violet-500 animate-spin" />
                        <Volume2 className="w-5 h-5 text-violet-400 absolute inset-0 m-auto" />
                      </div>
                      <div>
                        <p className="text-white font-semibold text-base">جاري معالجة الفيديو</p>
                        <p className="text-slate-300 text-sm mt-1">{processingProgress || 'يتم تحضير الترجمة العربية...'}</p>
                        <p className="text-slate-500 text-xs mt-1">سيبدأ الفيديو تلقائياً بعد الانتهاء</p>
                      </div>
                      <div className="flex gap-1.5">
                        {[0, 1, 2].map(i => (
                          <motion.div key={i} className="w-2 h-2 rounded-full bg-violet-500"
                            animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
                            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }} />
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <AnimatePresence>
              {isRunning && currentSentence && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="px-4 py-3 bg-black/70 border-t border-white/10">
                  <p className="text-white text-center text-base font-medium leading-relaxed">{currentSentence}</p>
                  <div className="flex justify-center gap-4 mt-2">
                    <Button size="sm" variant="ghost" onClick={() => seekToSegment(-1)} className="text-slate-300 hover:text-white hover:bg-white/10">
                      <ChevronRight className="w-4 h-4 ml-1" />السابق
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => seekToSegment(1)} className="text-slate-300 hover:text-white hover:bg-white/10">
                      التالي<ChevronLeft className="w-4 h-4 mr-1" />
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </Card>
        )}

        {/* Hidden dual audio elements */}
        <audio ref={audioARef} className="hidden" preload="auto" />
        <audio ref={audioBRef} className="hidden" preload="auto" />

        {/* Control Button */}
        {isValid && ytReady && (
          <div className="flex gap-3">
            {!isRunning ? (
              <Button onClick={startTranslation} disabled={!selectedVoice || !hasSavedCookies}
                className="flex-1 bg-violet-600 hover:bg-violet-500 text-white gap-2 h-11 disabled:opacity-50">
                <Play className="w-4 h-4" />
                {!hasSavedCookies ? 'أضف كوكيز Gemini أولاً' : 'شغّل مع الترجمة العربية'}
              </Button>
            ) : (
              <Button onClick={stopTranslation} variant="destructive" className="flex-1 gap-2 h-11">
                <Square className="w-4 h-4" />إيقاف الترجمة
              </Button>
            )}
          </div>
        )}

        {/* ── Sync Controls — visible while translation is running ─────────── */}
        <AnimatePresence>
          {isRunning && (
            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <Card className="bg-slate-900/50 border-slate-800/60 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-slate-400">ضبط المزامنة</span>
                  <span className={`text-xs font-mono px-2 py-0.5 rounded-full ${
                    syncOffset === 0 ? 'text-slate-500 bg-slate-800/50'
                    : syncOffset > 0 ? 'text-amber-400 bg-amber-900/20'
                    : 'text-sky-400 bg-sky-900/20'
                  }`}>
                    {syncOffset === 0 ? '0.0s' : `${syncOffset > 0 ? '+' : ''}${syncOffset.toFixed(1)}s`}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {/* Reset */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={resetSync}
                    className="border-slate-700 bg-slate-800/50 text-slate-300 hover:bg-slate-700 hover:text-white gap-1 text-xs h-8"
                    title="إعادة ضبط المزامنة"
                  >
                    <RotateCcw className="w-3 h-3" />
                    إعادة
                  </Button>

                  {/* ← 0.5s — تأخير الصوت (يتراجع للخلف) */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => adjustSync(-0.5)}
                    className="border-slate-700 bg-slate-800/50 text-sky-300 hover:bg-slate-700 hover:text-sky-200 font-mono text-xs h-8"
                    title="تأخير الصوت 0.5 ثانية"
                  >
                    ← 0.5s
                  </Button>

                  {/* 0.5s → — تقديم الصوت (يتقدم للأمام) */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => adjustSync(+0.5)}
                    className="border-slate-700 bg-slate-800/50 text-amber-300 hover:bg-slate-700 hover:text-amber-200 font-mono text-xs h-8"
                    title="تقديم الصوت 0.5 ثانية"
                  >
                    0.5s →
                  </Button>

                  {/* Auto Sync */}
                  <Button
                    size="sm"
                    onClick={autoSync}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white gap-1 text-xs h-8"
                    title="مزامنة تلقائية"
                  >
                    <Zap className="w-3 h-3" />
                    Auto
                  </Button>
                </div>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {hasStarted && activeSeg >= 0 && isWaitingForProcess && (
          <PipelineBar isVisible={true} progressText={processingProgress} segmentLabel={segLabel(activeSeg)} done={activeJob?.status === 'completed'} />
        )}

        {jobs.size > 0 && (
          <Card className="bg-slate-900/30 border-slate-800/40 p-4">
            <h3 className="text-sm font-medium text-slate-400 mb-3">المقاطع ({jobs.size} مقطع)</h3>
            <div className="space-y-1.5 max-h-52 overflow-y-auto">
              {[...jobs.entries()].sort(([a], [b]) => a - b).map(([k, j]) => (
                <div key={k} className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  k === activeSeg ? 'bg-violet-900/30 border border-violet-700/40'
                  : j.status === 'completed' ? 'bg-emerald-900/20 border border-emerald-800/30'
                  : j.status === 'failed' ? 'bg-red-900/20 border border-red-800/30'
                  : 'bg-slate-800/50 border border-slate-700/30'}`}>
                  <span className="font-mono text-slate-300 text-xs">{segLabel(k)}</span>
                  <div className="flex items-center gap-2">
                    {j.status === 'completed' && j.videoSlowdown < 0.99 && (
                      <span className="text-xs text-amber-400 font-mono" title="سيبطئ الفيديو للمزامنة">
                        ×{j.videoSlowdown.toFixed(2)} 🎬
                      </span>
                    )}
                    {j.status === 'completed' && j.suggestedRate !== 1.0 && (
                      <span className="text-xs text-indigo-400 font-mono">{j.suggestedRate.toFixed(2)}x 🔊</span>
                    )}
                    {k === activeSeg && j.status === 'processing' && <Loader2 className="w-3 h-3 text-violet-400 animate-spin" />}
                    <span className={`text-xs ${j.status === 'completed' ? 'text-emerald-400' : j.status === 'failed' ? 'text-red-400' : 'text-yellow-400'}`}>
                      {j.status === 'completed' ? '✅' : j.status === 'failed' ? '❌' : '⏳'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ─── Cookies Panel ─────────────────────────────────────────────────── */}
        <Card className="bg-slate-900/30 border-slate-800/40">
          <button onClick={() => setShowCookies(!showCookies)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm text-slate-400 hover:text-slate-300 transition-colors">
            <div className="flex items-center gap-2 flex-wrap">
              <CookieStatusIcon />
              <span className="text-slate-300 font-medium">كوكيز Gemini</span>
              {hasSavedCookies && !geminiValidation && !geminiChecking && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-400">محفوظة — لم يتم التحقق</span>
              )}
              {geminiChecking && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-700/50 text-slate-400 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />جاري تحليل الكوكيز...
                </span>
              )}
              {geminiValidation?.valid && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-900/30 text-emerald-400">{geminiValidation.message}</span>
              )}
              {geminiValidation && !geminiValidation.valid && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-red-900/30 text-red-400">{geminiValidation.message}</span>
              )}
              {!hasSavedCookies && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-red-900/30 text-red-400">لا توجد كوكيز</span>
              )}
            </div>
            {showCookies ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          <AnimatePresence>
            {showCookies && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="px-4 pb-4 space-y-3 border-t border-slate-800/50 pt-3">
                  <p className="text-xs text-slate-500 leading-relaxed">
                    الصق كوكيز حساب Google بصيغة Netscape. يتم الحفظ والتحليل <strong className="text-slate-400">تلقائياً</strong> فور اللصق.
                  </p>

                  {hasSavedCookies && cookieStatus && (
                    <div className="bg-slate-800/40 rounded-lg p-3 space-y-1.5 text-xs">
                      <div className="flex items-center justify-between text-slate-400">
                        <span>حالة الكوكيز المحفوظة</span>
                        <span className={`font-medium ${cookieStatus.status === 'expired' ? 'text-amber-400' : 'text-emerald-400'}`}>
                          {cookieStatus.message}
                        </span>
                      </div>
                      <div className="flex gap-3 flex-wrap">
                        <span className={cookieStatus.hasPSID ? 'text-emerald-500' : 'text-red-500'}>
                          {cookieStatus.hasPSID ? '✓' : '✗'} __Secure-1PSID
                        </span>
                        <span className={cookieStatus.hasPSIDTS ? 'text-emerald-500' : 'text-slate-600'}>
                          {cookieStatus.hasPSIDTS ? '✓' : '–'} __Secure-1PSIDTS
                        </span>
                        <span className={cookieStatus.hasGemini ? 'text-emerald-500' : 'text-slate-600'}>
                          {cookieStatus.hasGemini ? '✓' : '–'} Gemini
                        </span>
                        <span className={cookieStatus.hasYouTube ? 'text-emerald-500' : 'text-slate-600'}>
                          {cookieStatus.hasYouTube ? '✓' : '–'} يوتيوب
                        </span>
                      </div>
                      {geminiValidation?.testResponse && (
                        <div className="text-emerald-400 mt-1">
                          اختبار Gemini: &ldquo;{geminiValidation.testResponse}&rdquo;
                        </div>
                      )}
                    </div>
                  )}

                  <div className="relative">
                    <Textarea
                      placeholder="# Netscape HTTP Cookie File&#10;.google.com  TRUE    /       TRUE    ...&#10;&#10;الصق الكوكيز هنا — يحفظ ويحلل تلقائياً"
                      value={cookieText}
                      onChange={e => handleCookieChange(e.target.value)}
                      className="bg-slate-800 border-slate-700 text-slate-300 text-xs font-mono h-32 resize-none"
                      dir="ltr"
                    />
                    {cookieSaving && (
                      <div className="absolute inset-0 bg-slate-800/80 rounded-md flex items-center justify-center gap-2 text-sm text-slate-300">
                        <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
                        جاري الحفظ والتحليل...
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2 flex-wrap">
                    {hasSavedCookies && !geminiChecking && (
                      <Button size="sm" variant="outline"
                        onClick={handleValidateNow}
                        className="border-violet-700/50 text-violet-300 hover:bg-violet-900/20 gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        تحقق من Gemini الآن
                      </Button>
                    )}
                    {geminiChecking && (
                      <Button size="sm" variant="outline" disabled className="border-slate-700 text-slate-500 gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />جاري التحليل...
                      </Button>
                    )}
                    {hasSavedCookies && (
                      <Button size="sm" variant="destructive" onClick={handleDeleteCookies} className="gap-1.5">
                        <Trash2 className="w-3.5 h-3.5" />حذف الكوكيز
                      </Button>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>

        <p className="text-center text-xs text-slate-600 pb-4">
          yt-dlp → Whisper (base) → Gemini AI → Edge TTS — سرعة ذكية حتى 1.7×
        </p>
      </div>
    </div>
  );
}
