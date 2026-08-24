import React, { useState, useEffect } from 'react';
import { MasteringSettings, Language } from '../types';
import { i18n } from '../lib/i18n';
import { CheckCircle2 } from 'lucide-react';

// (props and BANDS definition remain the same)
interface GraphicEQProps {
  settings: MasteringSettings;
  onChange: (key: keyof MasteringSettings, value: number) => void;
  onBatchChange: (updates: Partial<MasteringSettings>) => void;
  disabled?: boolean;
  lang?: Language;
}

const BANDS = [
  { key: 'eq31', label: '31' },
  { key: 'eq62', label: '62' },
  { key: 'eq125', label: '125' },
  { key: 'eq250', label: '250' },
  { key: 'eq500', label: '500' },
  { key: 'eq1k', label: '1k' },
  { key: 'eq2k', label: '2k' },
  { key: 'eq4k', label: '4k' },
  { key: 'eq8k', label: '8k' },
  { key: 'eq16k', label: '16k' },
] as const;

// More precise "Official / Standard Studio" curves based on standard 10-band octave EQ setups
const EQ_PRESETS = {
  Pop: { eq31: 0, eq62: 1.5, eq125: 0.5, eq250: -1.0, eq500: -1.5, eq1k: -1.0, eq2k: 0.5, eq4k: 1.5, eq8k: 2.0, eq16k: 1.0 },
  Rock: { eq31: 0, eq62: 2.0, eq125: 1.5, eq250: 0.5, eq500: -1.0, eq1k: -1.0, eq2k: 1.5, eq4k: 2.5, eq8k: 1.5, eq16k: 1.0 },
  Elec: { eq31: 3.5, eq62: 4.0, eq125: 1.0, eq250: -1.5, eq500: -2.5, eq1k: 0, eq2k: 1.0, eq4k: 2.5, eq8k: 3.5, eq16k: 2.5 },
  Class: { eq31: -1.0, eq62: 0, eq125: 0, eq250: 0, eq500: 0, eq1k: 0, eq2k: 1.0, eq4k: 1.0, eq8k: 0.5, eq16k: -1.5 },
  Acoust: { eq31: -2.5, eq62: -1.5, eq125: 0, eq250: -2.0, eq500: 0, eq1k: 1.5, eq2k: 2.5, eq4k: 2.0, eq8k: 1.0, eq16k: 1.0 },
};

export const GraphicEQ: React.FC<GraphicEQProps> = ({ settings, onChange, onBatchChange, disabled, lang = 'en' }) => {
  const t = i18n[lang];

  // Custom User Presets State
  const [customPresets, setCustomPresets] = useState<Record<number, Partial<MasteringSettings>>>({});
  const [activeCustomPreset, setActiveCustomPreset] = useState<number>(1);
  const [isSavedFlash, setIsSavedFlash] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('mastering_eq_custom_presets');
    if (stored) {
      try { setCustomPresets(JSON.parse(stored)); } catch { }
    }
  }, []);

  const handleSavePreset = () => {
    const currentEQParams = BANDS.reduce((acc, b) => {
       (acc as any)[b.key] = settings[b.key as keyof MasteringSettings];
       return acc;
    }, {} as Partial<MasteringSettings>);
    
    const newPresets = { ...customPresets, [activeCustomPreset]: currentEQParams };
    setCustomPresets(newPresets);
    localStorage.setItem('mastering_eq_custom_presets', JSON.stringify(newPresets));
    setIsSavedFlash(true);
    setTimeout(() => setIsSavedFlash(false), 1500);
  };

  const handlePresetClick = (num: number) => {
    setActiveCustomPreset(num);
    if (customPresets[num]) {
      onBatchChange(customPresets[num]);
    }
  };

  // Determine which preset is accurately matched
  const activeGenrePreset = Object.entries(EQ_PRESETS).find(([_, vals]) => {
    return BANDS.every(b => settings[b.key as keyof MasteringSettings] === (vals as any)[b.key]);
  })?.[0];

  const activeCustomPresetMatch = [1, 2, 3, 4, 5].find(num => {
    const p = customPresets[num];
    if (!p) return false;
    return BANDS.every(b => settings[b.key as keyof MasteringSettings] === p[b.key as keyof MasteringSettings]);
  });

  return (
    <div className={`bg-[#0c0d11] border border-[#1a1c22] rounded-md p-4 flex flex-col h-full shadow-inner transition-opacity ${disabled ? 'opacity-30 pointer-events-none' : ''}`}>
      <div className="flex items-center gap-2 mb-4 whitespace-nowrap overflow-x-auto pb-1 no-scrollbar shrink-0">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${disabled ? 'bg-gray-500' : 'bg-[var(--accent)] shadow-[0_0_8px_currentColor]'}`} />
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#888]">{(t as any).graphicEq || "10-Band Graphic EQ"}</span>
        
        <div className="flex gap-1 ml-4 border-l border-white/10 pl-4 shrink-0">
          {Object.entries(EQ_PRESETS).map(([name, vals]) => {
            const isActive = name === activeGenrePreset;
            return (
              <button
                key={name}
                onClick={() => onBatchChange(vals as Partial<MasteringSettings>)}
                className={`px-2 py-0.5 rounded-sm border text-[9px] font-bold uppercase tracking-wider transition-colors ${
                  isActive
                    ? "bg-[var(--accent)] border-[var(--accent)] text-black"
                    : "bg-black border-[#333] text-[var(--text-dim)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                }`}
              >
                {name}
              </button>
            )
          })}
        </div>

        <div className="flex gap-1 ml-2 border-l border-white/10 pl-2 shrink-0">
          {[1,2,3,4,5].map(num => {
             const isActive = activeCustomPresetMatch === num;
             return (
               <button
                 key={num}
                 onClick={() => {
                   setActiveCustomPreset(num);
                   if (customPresets[num]) onBatchChange(customPresets[num]);
                 }}
                 className={`w-6 h-6 flex items-center justify-center rounded-sm text-[10px] font-bold transition-colors border ${
                   isActive 
                     ? "bg-[var(--accent)] border-[var(--accent)] text-black" 
                     : activeCustomPreset === num
                        ? "bg-[#222] border-[var(--accent)] text-[var(--accent)]"
                        : customPresets[num] 
                          ? "bg-[#111] border-[#444] text-white hover:border-[var(--accent)]" 
                          : "bg-black border-[#222] text-[#555] hover:text-[#999] hover:bg-[#151515]"
                 }`}
                 title={customPresets[num] ? `Load Custom EQ ${num}` : `Select EQ Slot ${num}`}
               >
                 {num}
               </button>
             )
          })}
        </div>

        <button 
           onClick={handleSavePreset}
           className={`mx-2 text-[9px] px-3 py-1.5 border uppercase font-bold tracking-widest rounded-sm transition-all flex items-center gap-1 shrink-0 ${
             isSavedFlash 
               ? "bg-green-500 border-green-500 text-black outline-none shadow-[0_0_10px_rgba(34,197,94,0.5)]" 
               : "bg-black border-[#444] hover:border-[var(--accent)] hover:text-[#fff] text-[var(--text-dim)]"
           }`}
           title={`Save to EQ slot ${activeCustomPreset}`}
         >
           {isSavedFlash ? <CheckCircle2 size={12} /> : null}
           {isSavedFlash ? ((t as any).done || "Saved") : ((t as any).savePreset || "Save")}
        </button>

        <div className="h-[1px] flex-1 bg-white/5 mx-2 min-w-[20px]" />
        
        <button 
          onClick={() => {
            const zeros = BANDS.reduce((acc, b) => ({ ...acc, [b.key]: 0 }), {});
            onBatchChange(zeros);
          }}
          className="text-[9px] font-bold text-[var(--text-dim)] hover:text-[var(--accent)] uppercase tracking-widest transition-colors shrink-0"
        >
          {(t as any).flatten || "Flatten"}
        </button>
      </div>
      
      <div className="flex justify-between items-end flex-1 min-h-[100px] px-2 relative mt-2 pb-2">
        <div className="absolute inset-x-2 top-1/2 -translate-y-1/2 h-[1px] bg-white/5 pointer-events-none" />
        {BANDS.map(({ key, label }) => {
          const value = settings[key as keyof MasteringSettings] as number;
          const percent = ((value + 12) / 24) * 100;
          return (
            <div key={key} className="flex flex-col items-center h-full group z-10 w-8 relative">
              <span className="text-[9px] font-mono font-bold text-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity absolute -top-5">
                {value > 0 ? '+' : ''}{value.toFixed(1)}
              </span>
              <div className="relative w-1.5 h-full bg-[#0a0a0d] rounded-full border border-white/5 my-2 overflow-visible">
                 <div className="absolute bottom-0 w-full bg-[var(--accent)] rounded-full transition-all duration-75 pointer-events-none shadow-[0_0_8px_var(--accent-dim)]" style={{height: `${percent}%`}}>
                    <div className="absolute -top-1.5 -left-[4.5px] w-3.5 h-3.5 bg-white rounded-full border-2 border-[var(--accent)] shadow-[0_0_10px_var(--accent-dim)]" />
                 </div>
                 <input
                    type="range"
                    min={-12}
                    max={12}
                    step={0.1}
                    value={value}
                    onChange={(e) => onChange(key as keyof MasteringSettings, parseFloat(e.target.value))}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    style={{ writingMode: 'vertical-lr', direction: 'rtl' } as any}
                 />
              </div>
              <span className="text-[9px] font-mono text-[#555] uppercase mt-auto pt-1 group-hover:text-white transition-colors">
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
