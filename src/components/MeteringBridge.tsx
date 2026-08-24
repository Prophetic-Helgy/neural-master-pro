import React, { useEffect, useState } from 'react';
import { Language } from '../types';
import { i18n } from '../lib/i18n';
import { LoudnessMeter, SILENCE_DB } from '../lib/audioMeters';

interface MeterProps {
  label: string;
  /** Linear 0..1 level (used when dbValue is absent). */
  value?: number;
  /** Absolute dB/LU reading (preferred for LUFS). */
  dbValue?: number;
  /** Scale floor for the bar, default -60. */
  minDb?: number;
  color?: string;
  /** Readout unit, default "dB". */
  unit?: string;
}

const Meter: React.FC<MeterProps> = ({
  label,
  value,
  dbValue,
  minDb = -60,
  color = "bg-[var(--accent)]",
  unit = "dB",
}) => {
  const reading = dbValue ?? (value != null && value > 0.000001 ? 20 * Math.log10(value) : minDb);
  const clampedDb = Math.max(minDb, Math.min(0, reading));
  const percent = ((clampedDb - minDb) / (0 - minDb)) * 100;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between items-center px-1 min-w-0">
        <span className="text-[10px] font-mono font-bold uppercase tracking-tighter text-[#444] truncate mr-2" title={label}>{label}</span>
        <span className="text-[11px] font-mono text-white/90 tabular-nums font-bold whitespace-nowrap shrink-0">
          {clampedDb <= minDb + 0.5 ? "-∞" : clampedDb.toFixed(1)} <span className="text-[8px] text-[var(--text-dim)] uppercase ml-0.5">{unit}</span>
        </span>
      </div>
      <div className="h-4 bg-[#0a0a0c] border border-white/5 relative overflow-hidden flex items-center p-0.5 rounded-sm shadow-inner group">
        {/* Background segments */}
        <div className="absolute inset-0 opacity-[0.03] z-0"
          style={{
            backgroundImage: `repeating-linear-gradient(90deg, transparent, transparent 3px, #fff 3px, #fff 4px)`,
            backgroundSize: '4px 100%'
          }}
        />

        {/* Active segments */}
        <div
          className={`h-full ${color} shadow-[0_0_15px_rgba(0,255,210,0.4)] transition-[width] duration-30 ease-out z-10 relative`}
          style={{
            width: `${percent}%`,
            maskImage: `repeating-linear-gradient(90deg, #000, #000 3px, transparent 3px, transparent 4px)`,
            maskSize: '4px 100%'
          }}
        />

        {/* Gradient Overlay for professional look */}
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-black/40 z-20 pointer-events-none" />
      </div>
    </div>
  );
};

interface MeteringBridgeProps {
  isPlaying: boolean;
  analysers: { L: AnalyserNode; R: AnalyserNode } | null;
  lang: Language;
}

export const MeteringBridge: React.FC<MeteringBridgeProps> = ({ isPlaying, analysers, lang }) => {
  const t = i18n[lang];
  const [meters, setMeters] = useState({
    peakL: 0,
    peakR: 0,
    lufs: SILENCE_DB,
    stLufs: SILENCE_DB,
    rms: 0,
    phase: 0.5
  });

  useEffect(() => {
    if (!analysers || !isPlaying) {
      setMeters({ peakL: 0, peakR: 0, lufs: SILENCE_DB, stLufs: SILENCE_DB, rms: 0, phase: 0.5 });
      return;
    }

    const sr = analysers.L.context.sampleRate;
    const meter = new LoudnessMeter(sr);
    const bufferLength = analysers.L.frequencyBinCount;
    const dataL = new Float32Array(bufferLength);
    const dataR = new Float32Array(bufferLength);
    let tPrev = analysers.L.context.currentTime;
    let animationFrameId: number;

    const update = () => {
      analysers.L.getFloatTimeDomainData(dataL);
      analysers.R.getFloatTimeDomainData(dataR);

      // Sample-accurate loudness feed: advance the K-weighting chain by
      // exactly the number of new samples since the last read. The buffer
      // always holds the most recent `bufferLength` samples, so the new
      // tail is its last `advance` entries — no sample duplication (which
      // would corrupt the biquad state) and no over/under-feeding.
      const tNow = analysers.L.context.currentTime;
      const advance = Math.round((tNow - tPrev) * sr);
      tPrev = tNow;
      if (advance > 0 && advance < bufferLength) {
        meter.push(dataL.subarray(bufferLength - advance), dataR.subarray(bufferLength - advance));
      }

      let sumSqL = 0;
      let sumSqR = 0;
      let maxL = 0;
      let maxR = 0;
      let crossProduct = 0;

      for (let i = 0; i < bufferLength; i++) {
        const sampleL = dataL[i];
        const sampleR = dataR[i];

        sumSqL += sampleL * sampleL;
        sumSqR += sampleR * sampleR;

        if (Math.abs(sampleL) > maxL) maxL = Math.abs(sampleL);
        if (Math.abs(sampleR) > maxR) maxR = Math.abs(sampleR);

        crossProduct += sampleL * sampleR;
      }

      const rmsL = Math.sqrt(sumSqL / bufferLength);
      const rmsR = Math.sqrt(sumSqR / bufferLength);
      const rmsTotal = (rmsL + rmsR) / 2;

      const divider = Math.sqrt(sumSqL * sumSqR);
      const correlation = divider > 1e-8 ? crossProduct / divider : 1;

      setMeters(prev => ({
        peakL: Math.max(prev.peakL * 0.92, maxL),
        peakR: Math.max(prev.peakR * 0.92, maxR),
        rms: Math.max(prev.rms * 0.85, rmsTotal),
        lufs: meter.momentary,
        stLufs: meter.shortTerm,
        phase: prev.phase * 0.8 + (0.5 + (correlation * 0.5)) * 0.2
      }));

      animationFrameId = requestAnimationFrame(update);
    };

    update();
    return () => cancelAnimationFrame(animationFrameId);
  }, [analysers, isPlaying]);

  return (
    <div className="grid grid-cols-[1fr_1fr_1fr_1fr_180px] gap-6 bg-[#0a0a0c] p-5 border-t border-white/5 relative studio-grid">
      <div className="absolute inset-0 bg-gradient-to-b from-black/20 to-transparent pointer-events-none" />

      <Meter label={`${t.peak} L`} value={meters.peakL} color="bg-cyan-500" />
      <Meter label={`${t.peak} R`} value={meters.peakR} color="bg-cyan-500" />
      <Meter label={t.rms} value={meters.rms} color="bg-blue-600" />
      <div className="flex flex-col gap-1.5">
        <Meter label={t.lufs} dbValue={meters.lufs} minDb={-30} color="bg-emerald-600" unit="LU" />
        <div className="flex justify-between px-1 text-[9px] font-mono text-[var(--text-dim)] uppercase tracking-tighter">
          <span>S 3s</span>
          <span className="text-white/70 tabular-nums">
            {meters.stLufs <= SILENCE_DB + 0.5 ? "-∞" : meters.stLufs.toFixed(1)} LU
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 pt-0.5">
        <div className="flex justify-between items-center px-1 min-w-0">
          <span className="text-[10px] font-mono font-bold uppercase tracking-tighter text-[#444] truncate" title={t.phaseCorr}>{t.phaseCorr}</span>
        </div>
        <div className="h-4 bg-[#0a0a0c] border border-white/5 relative overflow-hidden flex items-center rounded-sm">
          <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-white/10 z-10" />
          <div
            className="absolute top-0 bottom-0 w-1 bg-[var(--accent)] shadow-[0_0_15px_var(--accent)] transition-all duration-75 z-20"
            style={{ left: `${meters.phase * 100}%` }}
          />
          <div className="absolute inset-0 flex justify-between px-2 text-[8px] font-black text-white/10 pointer-events-none items-center z-0 uppercase tracking-tighter">
            <span>-1</span>
            <span>0</span>
            <span>+1</span>
          </div>
        </div>
      </div>
    </div>
  );
};
