import React from 'react';
import { MasteringSettings } from '../types';

interface ParametricEQProps {
  settings: MasteringSettings;
  onChange: (key: keyof MasteringSettings, value: number) => void;
  disabled?: boolean;
  t: Record<string, string>;
}

const BANDS = [1, 2, 3, 4];

// PEQ freq slider 0..100 is log-scaled 20 Hz..20 kHz in the DSP.
const toHz = (v: number) => Math.round(20 * Math.pow(10, 3 * v / 100));

export const ParametricEQ: React.FC<ParametricEQProps> = ({ settings, onChange, disabled, t }) => (
  <div className="flex flex-col gap-2">
    {BANDS.map((i) => {
      const gain = settings[`peq${i}Gain` as keyof MasteringSettings] as number;
      const freq = settings[`peq${i}Freq` as keyof MasteringSettings] as number;
      const q = settings[`peq${i}Q` as keyof MasteringSettings] as number;
      const type = settings[`peq${i}Type` as keyof MasteringSettings] as number;
      return (
        <div key={i} className={`bg-[#111216] border border-[#222328] rounded-md p-2 transition-all ${disabled ? 'opacity-30 pointer-events-none' : 'hover:border-[var(--accent)]/40'}`}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--text-dim)]">
              {t.peqBand} {i}
            </span>
            <div className="flex items-center gap-1">
              <span className="text-[8px] uppercase text-[#555]">{t.peqType}</span>
              <select
                data-testid={`peq${i}-type`}
                value={type}
                disabled={disabled}
                onChange={(e) => onChange(`peq${i}Type` as keyof MasteringSettings, parseFloat(e.target.value))}
                className="bg-black border border-[#2a2d35] rounded-sm text-[9px] text-[var(--accent)] font-bold px-1 py-0.5 outline-none focus:border-[var(--accent)]/50 cursor-pointer"
              >
                <option value={0}>{t.peqPeak}</option>
                <option value={1}>{t.peqLowShelf}</option>
                <option value={2}>{t.peqHighShelf}</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[8px] w-8 shrink-0 text-[#555] uppercase">{t.peqGain}</span>
            <input
              data-testid={`peq${i}-gain`}
              type="range"
              min={-12} max={12} step={0.01}
              value={gain}
              disabled={disabled}
              onChange={(e) => onChange(`peq${i}Gain` as keyof MasteringSettings, parseFloat(e.target.value))}
              className="flex-1 h-1 bg-black/80 rounded-full appearance-none cursor-pointer accent-[var(--accent)]"
            />
            <span className="text-[9px] font-mono text-[var(--accent)] w-10 text-right">{gain >= 0 ? '+' : ''}{gain.toFixed(1)}</span>
          </div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[8px] w-8 shrink-0 text-[#555] uppercase">{t.peqFreq}</span>
            <input
              data-testid={`peq${i}-freq`}
              type="range"
              min={0} max={100} step={0.1}
              value={freq}
              disabled={disabled}
              onChange={(e) => onChange(`peq${i}Freq` as keyof MasteringSettings, parseFloat(e.target.value))}
              className="flex-1 h-1 bg-black/80 rounded-full appearance-none cursor-pointer accent-[var(--accent)]"
            />
            <span className="text-[9px] font-mono text-[var(--accent)] w-10 text-right">{toHz(freq)} Hz</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[8px] w-8 shrink-0 text-[#555] uppercase">{t.peqQ}</span>
            <input
              data-testid={`peq${i}-q`}
              type="range"
              min={0.1} max={10} step={0.1}
              value={q}
              disabled={disabled || type !== 0}
              onChange={(e) => onChange(`peq${i}Q` as keyof MasteringSettings, parseFloat(e.target.value))}
              className="flex-1 h-1 bg-black/80 rounded-full appearance-none cursor-pointer accent-[var(--accent)] disabled:opacity-40"
            />
            <span className="text-[9px] font-mono text-[var(--accent)] w-10 text-right">{q.toFixed(1)}</span>
          </div>
        </div>
      );
    })}
  </div>
);
