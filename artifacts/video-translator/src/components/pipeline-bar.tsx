import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AudioLines, Languages, Mic, Download, Sparkles, CheckCircle2 } from 'lucide-react';

interface PipelineBarProps {
  isVisible: boolean;
  progressText: string;
  segmentLabel: string;
  done: boolean;
}

function textToPercent(text: string): number {
  if (!text) return 5;
  if (text.includes('تنزيل') || text.includes('استخراج') || text.includes('⬇️')) return 20;
  if (text.includes('Whisper') || text.includes('تحويل') || text.includes('🎙️')) return 55;
  if (text.includes('ترجمة') || text.includes('🌍')) return 75;
  if (text.includes('توليد') || text.includes('Edge') || text.includes('🔊')) return 90;
  if (text.includes('اكتمل') || text.includes('✅')) return 100;
  return 10;
}

function getIcon(text: string) {
  if (text.includes('🎙️') || text.includes('Whisper') || text.includes('نص')) return <Mic className="w-4 h-4" />;
  if (text.includes('ترجمة') || text.includes('🌍')) return <Languages className="w-4 h-4" />;
  if (text.includes('توليد') || text.includes('🔊') || text.includes('TTS')) return <Sparkles className="w-4 h-4" />;
  if (text.includes('تنزيل') || text.includes('⬇️')) return <Download className="w-4 h-4" />;
  if (text.includes('اكتمل') || text.includes('✅')) return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
  return <AudioLines className="w-4 h-4" />;
}

export function PipelineBar({ isVisible, progressText, segmentLabel, done }: PipelineBarProps) {
  const [displayPercent, setDisplayPercent] = useState(0);
  const targetPercent = done ? 100 : textToPercent(progressText);

  useEffect(() => {
    if (!isVisible) { setDisplayPercent(0); return; }
    const diff = targetPercent - displayPercent;
    if (Math.abs(diff) < 1) return;
    const step = diff > 0 ? Math.max(1, diff * 0.15) : diff;
    const t = setTimeout(() => setDisplayPercent(p => Math.min(100, Math.max(0, p + step))), 60);
    return () => clearTimeout(t);
  }, [targetPercent, displayPercent, isVisible]);

  useEffect(() => {
    if (isVisible && !done) setDisplayPercent(2);
  }, [segmentLabel]);

  const steps = [
    { label: 'تنزيل الصوت', threshold: 20 },
    { label: 'تحويل لنص', threshold: 55 },
    { label: 'ترجمة', threshold: 75 },
    { label: 'توليد صوت', threshold: 90 },
    { label: 'جاهز!', threshold: 100 },
  ];

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          className="w-full rounded-xl bg-slate-800/80 border border-slate-700/50 p-4"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-slate-300 text-sm">
              <motion.div
                animate={done ? {} : { rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              >
                {getIcon(progressText)}
              </motion.div>
              <span className="font-medium">معالجة الخلفية</span>
            </div>
            {segmentLabel && (
              <span className="text-xs text-slate-400 bg-slate-700/50 px-2 py-0.5 rounded-full">
                {segmentLabel}
              </span>
            )}
          </div>

          <div className="relative h-2 bg-slate-700 rounded-full overflow-hidden mb-2">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-400"
              style={{ width: `${displayPercent}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>

          <div className="flex justify-between mt-1">
            {steps.map((step) => (
              <span
                key={step.label}
                className={`text-xs transition-colors duration-500 ${
                  displayPercent >= step.threshold
                    ? 'text-indigo-300'
                    : 'text-slate-600'
                }`}
              >
                {step.label}
              </span>
            ))}
          </div>

          <p className="mt-2 text-xs text-slate-400 truncate">{progressText}</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
