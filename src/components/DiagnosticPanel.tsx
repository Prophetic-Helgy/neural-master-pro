import React from 'react';
import { AudioSnapshot, Language } from '../types';
import { Terminal, Copy, CheckCircle2, Sparkles } from 'lucide-react';
import { motion } from 'motion/react';
import { i18n } from '../lib/i18n';
import type { PipelineMetrics } from '../lib/audioMeters';

interface DiagnosticPanelProps {
  logs: AudioSnapshot[];
  lang: Language;
  onAiAnalyze?: () => void;
  aiAnalyzing?: boolean;
  aiReport?: string | null;
  aiReportError?: string | null;
  /** Full pre-mastering metrics for the loaded track (measureMetrics, async). */
  trackMetrics?: PipelineMetrics | null;
  trackMetricsBusy?: boolean;
}

const Sparkline: React.FC<{ data: { t: number; v: number }[] }> = ({ data }) => {
  if (!data || data.length === 0) return null;
  const min = -50;
  const max = 0;
  const range = max - min;
  
  return (
    <div className="h-12 w-full flex items-end gap-[1px] bg-black/40 rounded border border-white/5 px-1 py-1 mt-3 group">
      {data.map((p, i) => {
        const val = Math.max(min, Math.min(max, p.v));
        const h = ((val - min) / range) * 100;
        return (
          <div 
            key={i} 
            className="flex-1 bg-[var(--accent)]/20 group-hover:bg-[var(--accent)]/40 transition-colors" 
            style={{ height: `${Math.max(2, h)}%` }}
            title={`${p.t}s: ${p.v.toFixed(1)} dB`}
          />
        );
      })}
    </div>
  );
};

export const DiagnosticPanel: React.FC<DiagnosticPanelProps> = ({ logs, lang, onAiAnalyze, aiAnalyzing, aiReport, aiReportError, trackMetrics, trackMetricsBusy }) => {
  const [copied, setCopied] = React.useState(false);
  const t = i18n[lang];

  const handleCopy = () => {
    const text = JSON.stringify(logs, null, 2);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-[#0a0a0c] border border-[var(--border)] rounded-lg overflow-hidden flex flex-col h-full w-full"
    >
      <div className="bg-[#16181d] px-4 py-2 border-b border-[var(--border)] flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-[var(--accent)]" />
          <span className="text-[10px] uppercase font-bold tracking-widest text-white">{t.logTitle}</span>
        </div>
        {logs.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-2 px-3 py-1 bg-black border border-[var(--border)] rounded-sm text-[9px] font-bold uppercase tracking-widest text-[var(--text-dim)] hover:text-white transition-colors"
            >
              {copied ? <CheckCircle2 size={12} className="text-green-500" /> : <Copy size={12} />}
              {copied ? t.done : t.copyAI}
            </button>
            {onAiAnalyze && (
              <button
                onClick={onAiAnalyze}
                disabled={aiAnalyzing || logs.length === 0}
                className="flex items-center gap-2 px-3 py-1 bg-black border border-[var(--border)] rounded-sm text-[9px] font-bold uppercase tracking-widest text-[var(--accent)] hover:bg-[#16181d] transition-colors disabled:opacity-40"
              >
                <Sparkles size={12} />
                {aiAnalyzing ? ((t as any).aiAnalyzing || "Analyzing…") : ((t as any).aiReport || "AI Report")}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] space-y-4">
        {(trackMetricsBusy || trackMetrics) && (
          <div className="border border-[var(--border)] rounded-sm p-3 bg-black/40">
            <div className="text-[9px] uppercase font-bold tracking-widest text-[var(--accent)] mb-2">{t.trackAnalysis}</div>
            {trackMetricsBusy && !trackMetrics ? (
              <p className="text-[10px] text-[var(--text-dim)]">{t.measuring}</p>
            ) : trackMetrics ? (
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-[10px] text-[var(--text-dim)]">
                <div className="flex justify-between"><span>LUFS:</span> <span className="text-white">{trackMetrics.integratedLufs.toFixed(2)}</span></div>
                <div className="flex justify-between"><span>{t.truePeak}:</span> <span className={trackMetrics.truePeakDb > -1.5 ? 'text-red-400' : 'text-white'}>{trackMetrics.truePeakDb.toFixed(2)} dBTP</span></div>
                <div className="flex justify-between"><span>{t.lra}:</span> <span className="text-white">{trackMetrics.lra.toFixed(2)} LU</span></div>
                <div className="flex justify-between"><span>Crest:</span> <span className="text-blue-400">{trackMetrics.crestDb.toFixed(2)} dB</span></div>
                <div className="flex justify-between"><span>Corr:</span> <span className={trackMetrics.correlation < 0 ? 'text-red-500' : 'text-white'}>{trackMetrics.correlation.toFixed(2)}</span></div>
                <div className="flex justify-between"><span>{t.dcOffset}:</span> <span className={trackMetrics.dcOffsetDb > -40 ? 'text-yellow-400' : 'text-white'}>{trackMetrics.dcOffsetDb <= -119.9 ? '-∞' : `${trackMetrics.dcOffsetDb.toFixed(1)} dB`}</span></div>
              </div>
            ) : null}
          </div>
        )}
        {aiReportError && (
          <p className="text-[10px] text-red-400 border-l-2 border-red-500/50 pl-3">{aiReportError}</p>
        )}
        {aiReport && (
          <div className="border border-[var(--border)] rounded-sm p-3 max-h-56 overflow-y-auto bg-black/40">
            <div className="text-[9px] uppercase font-bold tracking-widest text-[var(--accent)] mb-2">
              {(t as any).aiReport || "AI Report"}
            </div>
            <p className="whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--text-dim)]">{aiReport}</p>
          </div>
        )}
        {logs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-[var(--text-dim)] gap-4">
            <Terminal size={40} className="opacity-10" />
            <p className="uppercase tracking-[4px] text-[9px] font-bold">{t.waitAudio}</p>
          </div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="border-l-2 border-[var(--accent)]/30 pl-4 py-1">
              <div className="text-[var(--accent)] font-bold mb-1">[{log.label}] - {new Date(log.timestamp).toLocaleTimeString()}</div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-[var(--text-dim)]">
                <div className="flex justify-between"><span>Peak:</span> <span className="text-white">{log.levels.peak.toFixed(2)} dB</span></div>
                <div className="flex justify-between"><span>RMS:</span> <span className="text-white">{log.levels.rms.toFixed(2)} dB</span></div>
                <div className="flex justify-between"><span>LUFS:</span> <span className="text-white">{log.levels.lufs.toFixed(2)} dB</span></div>
                <div className="flex justify-between"><span>Crest Factor:</span> <span className="text-blue-400">{log.levels.crestFactor.toFixed(2)} dB</span></div>
                <div className="flex justify-between"><span>Width:</span> <span className="text-white">{(log.stereo.width * 100).toFixed(1)}%</span></div>
                <div className="flex justify-between"><span>Correlation:</span> <span className={log.stereo.correlation < 0 ? 'text-red-500' : 'text-white'}>{log.stereo.correlation.toFixed(2)}</span></div>
              </div>

              {log.timeline && log.timeline.length > 0 && (
                <Sparkline data={log.timeline.map(p => ({ t: p.t, v: p.rms }))} />
              )}
              
              <div className="mt-2 grid grid-cols-6 gap-1 h-3 bg-white/5 rounded-full overflow-hidden">
                <div className="bg-red-500/50" style={{ width: `${log.spectrum.sub * 100}%` }} title="Sub" />
                <div className="bg-orange-500/50" style={{ width: `${log.spectrum.low * 100}%` }} title="Low" />
                <div className="bg-yellow-500/50" style={{ width: `${log.spectrum.lowMid * 100}%` }} title="LowMid" />
                <div className="bg-green-500/50" style={{ width: `${log.spectrum.mid * 100}%` }} title="Mid" />
                <div className="bg-blue-500/50" style={{ width: `${log.spectrum.highMid * 100}%` }} title="HighMid" />
                <div className="bg-purple-500/50" style={{ width: `${log.spectrum.high * 100}%` }} title="High" />
              </div>

              {log.settings && (
                <div className="mt-2 pt-2 border-t border-[var(--border)]/50 grid grid-cols-3 gap-1 text-[10px] text-cyan-400">
                  <div>{t.gain}: {log.settings.gain.toFixed(2)}</div>
                  <div>{t.compression}: {log.settings.compression.toFixed(2)}</div>
                  <div>{t.saturation}: {log.settings.saturation.toFixed(2)}</div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      
      <div className="p-3 bg-black/50 border-t border-[var(--border)]">
        <p className="text-[9px] text-[var(--text-dim)] leading-relaxed italic">
          {t.logFooter}
        </p>
      </div>
    </motion.div>
  );
};
