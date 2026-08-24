import React from 'react';
import { motion } from 'motion/react';
import { Info } from 'lucide-react';

interface ControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (val: number) => void;
  tooltip: string;
  unit?: string;
  displayValue?: number;
  resetValue?: number;
  disabled?: boolean;
}

export const MasteringControl: React.FC<ControlProps> = ({
  label, value, min, max, step, onChange, tooltip, unit = "", displayValue, resetValue = 0, disabled
}) => {
  const currentDisplay = displayValue !== undefined ? displayValue : value;
  
  return (
    <div className={`bg-[#111216] border border-[#222328] rounded-md p-3 group transition-all flex flex-col gap-2 relative shadow-inner ${disabled ? 'opacity-30 pointer-events-none' : 'hover:border-[var(--accent)]/40'}`}>
      <div className="flex justify-between items-center mb-1">
        <label className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-dim)] truncate">
          {label}
        </label>
        <button 
          onClick={() => onChange(resetValue)}
          className="w-4 h-4 rounded-full bg-black border border-[#333] flex items-center justify-center text-[var(--text-dim)] hover:text-white hover:border-[var(--accent)] transition-all active:scale-90"
          title={`Reset to ${resetValue}`}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        </button>
      </div>
      
      <div className="flex items-center bg-black/60 border border-[#2a2d35] rounded-sm focus-within:border-[var(--accent)]/50 transition-colors px-2 py-1 relative">
        <input 
          type="number"
          value={parseFloat(currentDisplay.toFixed(2))}
          step={step}
          min={displayValue !== undefined ? undefined : min}
          max={displayValue !== undefined ? undefined : max}
          onChange={(e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val)) {
              const rawVal = displayValue !== undefined ? val - (displayValue - value) : val;
              onChange(Math.max(min, Math.min(max, rawVal)));
            }
          }}
          className="w-full bg-transparent border-none text-[12px] font-mono text-[var(--accent)] font-bold text-center outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none mb-[1px]">
          <span className="text-[8px] text-[#444] font-bold uppercase tracking-tighter">
            {unit.trim() || 'LVL'}
          </span>
        </div>
      </div>

      <div className="relative pt-1 pb-1">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full h-1.5 bg-black/80 rounded-full appearance-none cursor-pointer accent-[var(--accent)] border border-white/5"
        />
      </div>
      
      <div className="mt-1">
         <div className="h-[1px] w-full bg-gradient-to-r from-transparent via-[#222] to-transparent mb-2" />
         <p className="text-[9px] leading-relaxed text-[var(--text-dim)] opacity-50 group-hover:opacity-100 transition-opacity">
          {tooltip}
        </p>
      </div>
    </div>
  );
};
