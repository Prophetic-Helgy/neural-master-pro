/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Music, 
  Upload, 
  Play, 
  Square, 
  Download, 
  Settings2, 
  Sparkles, 
  Languages,
  Monitor,
  Cpu,
  Image as ImageIcon,
  CheckCircle2,
  Info,
  Maximize,
  X,
  Minus
} from 'lucide-react';
import { AudioEngine } from './lib/AudioEngine';
import { encodeAudio } from './lib/exportEncoders';
import { zipSync } from 'fflate';
import { i18n } from './lib/i18n';
import { Language, MasteringSettings, TrackMetadata, ExportFormat, ExportQuality, AudioSnapshot, EffectRegion, TargetStem, PexelsClip, PexelsVideoFile, PexelsSelectionItem } from './types';
import type { PipelineMetrics } from './lib/audioMeters';
import { AudioVisualizer } from './components/AudioVisualizer';
import { MasteringControl } from './components/MasteringControl';
import { MeteringBridge } from './components/MeteringBridge';
import { DiagnosticPanel } from './components/DiagnosticPanel';
import { LiteMaster } from './components/LiteMaster';
import { getAutoMasterSettings } from './services/geminiService';
import { searchPexelsVideos, pickBestRendition, ensureClipBlob, PexelsApiError, MAX_PEXELS_CLIPS, hasPexelsKey, setPexelsKey } from './services/pexelsService';
import { findPeakCuePoints } from './lib/audioMeters';
import { recognizeLyrics } from './lib/asrClient';
import { segmentsToSrt, type SubtitleSegment } from './lib/subtitles';
import { loadLlmConfig, saveLlmConfig, llmAutoMaster, llmAiReport, LlmConfig, LlmError } from './services/llmService';
import { LlmSettingsModal } from './components/LlmSettingsModal';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { GraphicEQ } from './components/GraphicEQ';
import { ParametricEQ } from './components/ParametricEQ';
import VocalAlignPanel from './components/VocalAlignPanel';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const USER_PRESET_1: MasteringSettings = {
  gain: 4.8,
  lowShelf: -4.92,
  midRange: -4.02,
  highShelf: 2.82,
  fundamentalFreq: 200,
  compression: -0.13, 
  limiter: -5, 
  saturation: -1.99, 
  exciterAmount: 1.02,
  exciterFreq: 5000,
  haasAmount: 25.94,
  stereoWidth: 20.49, 
  dithering: true,
  eq31: 0,
  eq62: 0,
  eq125: 0,
  eq250: 0,
  eq500: 0,
  eq1k: 0,
  eq2k: 0,
  eq4k: 0,
  eq8k: 0,
  eq16k: 0,
  autotune: 0,
  reverb: 0,
  distortion: 0,
  delay: 0,
  chorus: 0,
  bass_autotune: 0, bass_reverb: 0, bass_distortion: 0, bass_delay: 0, bass_chorus: 0,
  mid_autotune: 0, mid_reverb: 0, mid_distortion: 0, mid_delay: 0, mid_chorus: 0,
  side_autotune: 0, side_reverb: 0, side_distortion: 0, side_delay: 0, side_chorus: 0,
  vocal_autotune: 0, vocal_reverb: 0, vocal_distortion: 0, vocal_delay: 0, vocal_chorus: 0,
  stem_solo: 0,
  peq1Freq: 15, peq1Q: 1, peq1Gain: 0, peq1Type: 0,
  peq2Freq: 40, peq2Q: 1, peq2Gain: 0, peq2Type: 0,
  peq3Freq: 65, peq3Q: 1, peq3Gain: 0, peq3Type: 0,
  peq4Freq: 85, peq4Q: 1, peq4Gain: 0, peq4Type: 0,
  widenerAmt: 0, mono: 0,
  compAmt: 0, compThresh: -18, compRatio: 3, compAttack: 10, compRelease: 150,
  gateAmt: 0, gateThresh: -48, gateRelease: 100,
  transAmt: 0, transFreq: 250,
  deessAmt: 0, deessFreq: 6000,
  tapeAmt: 0, tapeTone: 6000,
  airAmt: 0, airFreq: 8000,
  phaserAmt: 0, flangerAmt: 0, tremoloAmt: 0,
  bitDepth: 16, srHold: 1,
};

const NEUTRAL_SETTINGS: MasteringSettings = {
  gain: 0,
  lowShelf: 0,
  midRange: 0,
  highShelf: 0,
  fundamentalFreq: 60,
  compression: 0,
  limiter: 0,
  saturation: 0,
  exciterAmount: 0,
  exciterFreq: 5000,
  haasAmount: 0,
  stereoWidth: 0,
  dithering: true,
  eq31: 0,
  eq62: 0,
  eq125: 0,
  eq250: 0,
  eq500: 0,
  eq1k: 0,
  eq2k: 0,
  eq4k: 0,
  eq8k: 0,
  eq16k: 0,
  autotune: 0,
  reverb: 0,
  distortion: 0,
  delay: 0,
  chorus: 0,
  bass_autotune: 0, bass_reverb: 0, bass_distortion: 0, bass_delay: 0, bass_chorus: 0,
  mid_autotune: 0, mid_reverb: 0, mid_distortion: 0, mid_delay: 0, mid_chorus: 0,
  side_autotune: 0, side_reverb: 0, side_distortion: 0, side_delay: 0, side_chorus: 0,
  vocal_autotune: 0, vocal_reverb: 0, vocal_distortion: 0, vocal_delay: 0, vocal_chorus: 0,
  stem_solo: 0,
  peq1Freq: 15, peq1Q: 1, peq1Gain: 0, peq1Type: 0,
  peq2Freq: 40, peq2Q: 1, peq2Gain: 0, peq2Type: 0,
  peq3Freq: 65, peq3Q: 1, peq3Gain: 0, peq3Type: 0,
  peq4Freq: 85, peq4Q: 1, peq4Gain: 0, peq4Type: 0,
  widenerAmt: 0, mono: 0,
  compAmt: 0, compThresh: -18, compRatio: 3, compAttack: 10, compRelease: 150,
  gateAmt: 0, gateThresh: -48, gateRelease: 100,
  transAmt: 0, transFreq: 250,
  deessAmt: 0, deessFreq: 6000,
  tapeAmt: 0, tapeTone: 6000,
  airAmt: 0, airFreq: 8000,
  phaserAmt: 0, flangerAmt: 0, tremoloAmt: 0,
  bitDepth: 16, srHold: 1,
};

const getInitialPresets = () => {
  try {
    const saved = localStorage.getItem('mastering_custom_presets');
    if (saved) {
       const parsed = JSON.parse(saved);
       // Ensure older saved presets don't break the UI by missing new properties like stem fx
       const safeParsed: any = {};
       for (const key of Object.keys(parsed)) {
          safeParsed[key] = { ...NEUTRAL_SETTINGS, ...parsed[key] };
       }
       return { 1: USER_PRESET_1, ...safeParsed }; 
    }
  } catch (e) {
    console.error("Could not parse presets from local storage", e);
  }
  return { 1: USER_PRESET_1 };
};

/**
 * Honest GPU name for the browser (no fake "GPU (RTX 3080Ti)" strings).
 * Reads the WebGL renderer string, e.g.
 * "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)"
 * → "RTX 3080 Ti". Falls back to gl.RENDERER, then 'GPU'.
 */
function webglGpuName(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return 'GPU';
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const raw = ext
        ? String(gl.getParameter((ext as any).UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER));
      // "ANGLE (vendor, <model> <api suffix>, api)" → "<model> <api suffix>"
      let s = raw;
      const angle = s.match(/^ANGLE \((?:[^,]+), (.+)\)$/);
      if (angle) s = angle[1];
      s = s.replace(/^ANGLE Metal Renderer:\s*/i, '');
      s = s.replace(/\s*(Direct3D\d+|OpenGL\S*|Vulkan\S*).*$/i, '');
      s = s.replace(/\s*\(0x[0-9a-fA-F]+\)/g, ''); // NVIDIA device id, e.g. " (0x00002208)"
      s = s.replace(/^NVIDIA[,\s]+/i, '').replace(/^GeForce[,\s]+/i, '').replace(/^Intel\(R\)\s*/i, '').replace(/^AMD[,\s]+/i, '');
      s = s.replace(/\(TM\)|\(R\)/gi, '').replace(/\s{2,}/g, ' ').trim();
      return s || 'GPU';
    } finally {
      // Release the GL context — we only needed the string.
      (gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext?.();
    }
  } catch {
    return 'GPU';
  }
}

// --- Transport time display ------------------------------------------------
// App used to hold `currentTime` as state polled at 10 Hz, which re-rendered
// the whole ~2100-line JSX tree ten times a second. The time readout + seek
// bar now live in a small component with its own state, so only it re-renders
// at the polling rate.

const formatTime = (time: number) => {
  const mins = Math.floor(time / 60);
  const secs = Math.floor(time % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const TimeControls: React.FC<{
  engineRef: React.MutableRefObject<AudioEngine | null>;
  duration: number;
  hasTrack: boolean;
  onSeek: (t: number) => void;
}> = ({ engineRef, duration, hasTrack, onSeek }) => {
  const [time, setTime] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      const eng = engineRef.current;
      // getCurrentTime() returns a frozen offset while paused (the engine
      // snapshots it in stop()), so the slider holds its position.
      if (eng) setTime(eng.getCurrentTime());
    }, 100);
    return () => clearInterval(interval);
  }, [engineRef]);

  return (
    <div className="mb-2 space-y-1 relative">
      <div className="flex justify-between text-[10px] font-mono text-[var(--text-dim)] mb-1">
        <span>{formatTime(time)}</span>
        <span>{formatTime(duration)}</span>
      </div>
      <div className="relative w-full h-[6px] flex items-center bg-[#1a1c22] rounded-full overflow-hidden">
        <div
          className="absolute left-0 top-0 h-full bg-[#333] transition-all rounded-full pointer-events-none"
          style={{ width: `${duration > 0 ? (time / duration) * 100 : 0}%` }}
        />
        <input
          type="range"
          min="0"
          max={duration || 100}
          step="0.01"
          value={time}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setTime(v); // optimistic; the engine position comes back on the next poll
            onSeek(v);
          }}
          disabled={!hasTrack}
          className="absolute top-0 left-0 w-full h-[12px] appearance-none bg-transparent m-0 p-0 cursor-pointer outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-sm disabled:opacity-10 z-20"
        />
      </div>
    </div>
  );
};

/** Video-export ETA line with its own 10 Hz poll (see TimeControls note). */
const VideoExportProgress: React.FC<{
  engineRef: React.MutableRefObject<AudioEngine | null>;
  duration: number;
}> = ({ engineRef, duration }) => {
  const [time, setTime] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      const eng = engineRef.current;
      if (eng) setTime(eng.getCurrentTime());
    }, 100);
    return () => clearInterval(interval);
  }, [engineRef]);
  return <>{Math.min(100, Math.floor((time / duration) * 100))}% - ETA: {formatTime(duration - time)}</>;
};

export default function App() {
  const [lang, setLang] = useState<Language>('en');
  const [activeStem, setActiveStem] = useState<TargetStem>('master');
  const [track, setTrack] = useState<File | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  
  const [customPresets, setCustomPresets] = useState<Record<number, MasteringSettings>>(getInitialPresets());
  const [activePresetIndex, setActivePresetIndex] = useState<number>(1);
  const [settings, setSettings] = useState<MasteringSettings>(getInitialPresets()[1] || NEUTRAL_SETTINGS);
  const [metadata, setMetadata] = useState<TrackMetadata>({
    title: '',
    artist: '',
    album: '',
    genre: '',
  });
  const [processingMode, setProcessingMode] = useState<'gpu' | 'cpu'>('gpu');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('wav');
  const [exportQuality, setExportQuality] = useState<ExportQuality>('high');
  // Pro WAV bit depth (WAV only; MP3 is fixed 320 kbps, FLAC is 24-bit).
  const [proWavBit, setProWavBit] = useState<16 | 24 | 32>(24);
  // AAC quality (m4a, CBR). 256 = default, 128 = smaller file.
  const [aacKbps, setAacKbps] = useState<128 | 256>(256);
  const [aacState, setAacState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [isEngineReady, setIsEngineReady] = useState(false);

  // Pro is the default (2.2). Key bumped to v2: users who saved 'lite' in
  // 2.1 must get the new default instead of a stale value.
  const [appMode, setAppMode] = useState<'lite' | 'pro'>(() => {
    try { return (localStorage.getItem('nmp_app_mode_v2') as 'lite' | 'pro' | null) ?? 'pro'; }
    catch { return 'pro'; }
  });
  const switchMode = (m: 'lite' | 'pro') => {
    setAppMode(m);
    try {
      localStorage.setItem('nmp_app_mode_v2', m);
      localStorage.removeItem('nmp_app_mode'); // one-time cleanup of the old key
    } catch { /* ignore */ }
    // Pro mode plays the live Faust chain — drop any Lite preview buffer.
    if (m === 'pro') audioEngine.current?.setPreviewBuffer(null, false);
  };

  useEffect(() => {
    const checkReady = setInterval(() => {
      if (audioEngine.current?.isReady()) {
        setIsEngineReady(true);
        clearInterval(checkReady);
      }
    }, 500);
    return () => clearInterval(checkReady);
  }, []);
  const [coverArt, setCoverArt] = useState<string | null>(null);
  // Pan of the cover inside its frame: -1..1 per axis (0 = center). Only the
  // overflowing axis is active (depends on the image aspect). Stored
  // normalized so the same value drives the UI preview and the export
  // drawImage. Reset on every new cover.
  const [coverOffset, setCoverOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [coverAspect, setCoverAspect] = useState(1);
  const coverDragRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; maxPxX: number; maxPxY: number } | null>(null);
  const coverDragMovedRef = useRef(false);

  // New states
  const [monitorVolume, setMonitorVolume] = useState(1);
  const [playbackSpeed, setPlaybackSpeed] = useState(0);
  const [trimStart, setTrimStart] = useState<number | string>(0);
  const [trimEnd, setTrimEnd] = useState<number | string>(0);
  const hasAutoTrimRef = useRef(false);
  const logoRef = useRef<HTMLImageElement>(null);
  const [effectRegions, setEffectRegions] = useState<EffectRegion[]>([]);
  const [activeFXRegionId, setActiveFXRegionId] = useState<string | null>(null);
  // Guards the async metrics pass: a stale .then/.finally must not clear the
  // busy flag (or metrics) of a newer track.
  const measureGenRef = useRef(0);

  const neonColors = ['#00ffff', '#ff00ff', '#00ffaa', '#ffff00', '#ff00aa'];

  const handleAddFXRegion = () => {
    if (duration <= 0) return;
    
    // Grab the current settings for the active stem
    const currentEffects = {
      autotune: activeStem === 'master' ? settings.autotune : settings[`${activeStem}_autotune` as keyof MasteringSettings] as number,
      reverb: activeStem === 'master' ? settings.reverb : settings[`${activeStem}_reverb` as keyof MasteringSettings] as number,
      distortion: activeStem === 'master' ? settings.distortion : settings[`${activeStem}_distortion` as keyof MasteringSettings] as number,
      delay: activeStem === 'master' ? settings.delay : settings[`${activeStem}_delay` as keyof MasteringSettings] as number,
      chorus: activeStem === 'master' ? settings.chorus : settings[`${activeStem}_chorus` as keyof MasteringSettings] as number,
    };

    const newReg: EffectRegion = {
      id: Date.now().toString(),
      start: 0,
      end: Math.min(20, duration),
      targetStem: activeStem,
      color: neonColors[effectRegions.length % neonColors.length],
      effects: { ...currentEffects }
    };
    setEffectRegions([...effectRegions, newReg]);
    setActiveFXRegionId(newReg.id);
    // Auto-selection above silently switches the five FX sliders into
    // region-edit mode (they write into this window only, 0–20 s). Make it
    // visible or it reads as "FX don't work" outside the window.
    showToast(`${i18n[lang].fxRegionEditingHint} (${newReg.start}s–${Math.round(newReg.end)}s)`, 'warn');
  };

  const handleRemoveFXRegion = (id: string) => {
    setEffectRegions(effectRegions.filter(r => r.id !== id));
    if (activeFXRegionId === id) setActiveFXRegionId(null);
  };

  const updateRegionStart = (id: string, val: string) => {
    const v = parseFloat(val);
    setEffectRegions(prev => prev.map(r => r.id === id ? { ...r, start: isNaN(v) ? 0 : Math.max(0, Math.min(v, r.end - 0.01)) } : r));
  };

  const updateRegionEnd = (id: string, val: string) => {
    const v = parseFloat(val);
    setEffectRegions(prev => prev.map(r => r.id === id ? { ...r, end: isNaN(v) ? r.start + 0.01 : Math.min(duration, Math.max(v, r.start + 0.01)) } : r));
  };

  useEffect(() => {
    if (audioEngine.current) {
      audioEngine.current.setRegions(effectRegions);
    }
  }, [effectRegions]);

  useEffect(() => {
    let frame: number;
    let prevVal = 0;
    // Allocated once per effect run — a fresh Uint8Array per frame was GC churn
    let timeData: Uint8Array | null = null;
    const pulseLogo = () => {
      if (isPlaying && logoRef.current && audioEngine.current) {
        const analysers = audioEngine.current.getAnalysers();
        if (analysers && analysers.L) {
          const need = analysers.L.frequencyBinCount;
          if (!timeData || timeData.length !== need) timeData = new Uint8Array(need);
          analysers.L.getByteTimeDomainData(timeData);

          let localRms = 0;
          for (let i = 0; i < timeData.length; i++) {
            const v = (timeData[i] / 128) - 1;
            localRms += v * v;
          }
          localRms = Math.sqrt(localRms / timeData.length);
          const intensity = Math.min(localRms * 3, 1);

          let smoothed;
          if (intensity > prevVal) {
            smoothed = intensity; // instant attack
          } else {
            smoothed = prevVal * 0.7 + intensity * 0.3; // fast decay
          }
          prevVal = smoothed;

          const targetScale = 1.0 + (smoothed * 0.15);
          logoRef.current.style.transform = `scale(${targetScale.toFixed(3)})`;
        }
      } else if (logoRef.current && prevVal > 0) {
        logoRef.current.style.transform = `scale(1)`;
        prevVal = 0;
      }
      frame = requestAnimationFrame(pulseLogo);
    };
    frame = requestAnimationFrame(pulseLogo);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  const getSpeed = (val: number) => {
    if (val >= 0) return 1 + (2 * val / 3);
    return 1 / (1 + (2 * Math.abs(val) / 3));
  };
  
  // Hardware monitor states
  const [cpuTemp, setCpuTemp] = useState<number | null>(null);
  const [gpuTemp, setGpuTemp] = useState<number | null>(null);
  const [cpuLoad, setCpuLoad] = useState<number | null>(null);
  const [gpuLoad, setGpuLoad] = useState<number | null>(null);
  const [cpuName, setCpuName] = useState('CPU');
  const [gpuName, setGpuName] = useState('GPU');

  useEffect(() => {
    // Get hardware names once
    if (typeof window !== 'undefined' && (window as any).nmpIpc) {
      try {
        (window as any).nmpIpc.getHardwareInfo().then((info: any) => {
          if (info.cpuName) {
            let name = info.cpuName
              .replace(/Processor/ig, '')
              .replace(/\d+-Core/ig, '')
              .replace(/AMD/ig, '')
              .replace(/Intel\(R\)/ig, '')
              .replace(/Core\(TM\)/ig, '')
              .trim();
            setCpuName(name || 'CPU');
          }
          if (info.gpuName) {
            let name = info.gpuName
              .replace(/NVIDIA/ig, '')
              .replace(/GeForce/ig, '')
              .replace(/\(TM\)/ig, '')
              .replace(/\(R\)/ig, '')
              .trim();
            setGpuName(name || 'GPU');
          }
        }).catch(() => {});
      } catch(e) {}
    } else {
      // Browser: honest names. Core count from the OS, GPU from the WebGL
      // renderer string — never a fabricated "RTX 3080Ti".
      const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
      setCpuName(cores ? `CPU · ${cores}` : 'CPU');
      setGpuName(webglGpuName());
    }
  }, []);

  useEffect(() => {
    const getTemps = async () => {
      if (typeof window !== 'undefined' && (window as any).nmpIpc) {
        try {
          const stats = await (window as any).nmpIpc.getHardwareTemps();
          if (stats) {
            setCpuTemp(stats.cpuTemp !== undefined ? stats.cpuTemp : (stats.cpu || null));
            setGpuTemp(stats.gpuTemp !== undefined ? stats.gpuTemp : (stats.gpu || null));
            setCpuLoad(stats.cpuLoad || null);
            setGpuLoad(stats.gpuLoad || null);
          }
        } catch {
          // IPC failed or unavailable: no sensor API exists in a plain
          // browser, so we leave the state null ("--°C") instead of
          // fabricating numbers.
        }
      }
    };

    getTemps();
    const interval = setInterval(getTemps, 1500); 
    return () => clearInterval(interval);
  }, []);

  const [duration, setDuration] = useState(0);
  const [visMode, setVisMode] = useState<'bars' | 'circle' | 'wave' | 'alchemy' | 'circles' | 'flight' | 'smoke'>('bars');
  // Default 'master': a mastering app must process out of the box.
  // A/B against the original is one click away (SOURCE/REFERENCE buttons).
  // (Was 'source' — left the whole DSP chain bypassed and hard-disabled
  // every Pro slider on first launch, so FX "didn't work".)
  const [monitoringMode, setMonitoringMode] = useState<'master' | 'source' | 'reference'>('master');
  const [showLogs, setShowLogs] = useState(false);
  const [llmConfig, setLlmConfigState] = useState<LlmConfig | null>(() => loadLlmConfig());
  const [showLlmSettings, setShowLlmSettings] = useState(false);
  const [autoMasterNote, setAutoMasterNote] = useState<string | null>(null);
  const [aiReport, setAiReport] = useState<string | null>(null);
  const [aiReportBusy, setAiReportBusy] = useState(false);
  const [aiReportError, setAiReportError] = useState<string | null>(null);
  const [refTrack, setRefTrack] = useState<File | null>(null);
  const [analysisLogs, setAnalysisLogs] = useState<AudioSnapshot[]>([]);
  const [trackMetrics, setTrackMetrics] = useState<PipelineMetrics | null>(null);
  const [trackMetricsBusy, setTrackMetricsBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: 'error' | 'warn' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = (msg: string, kind: 'error' | 'warn' = 'error') => {
    setToast({ msg, kind });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 6000);
  };

  // Export states
  const [exportAudio, setExportAudio] = useState(true);
  const [exportVideo, setExportVideo] = useState(false);
  const [videoOrientation, setVideoOrientation] = useState<'vertical' | 'horizontal'>('vertical');
  const [videoRes, setVideoRes] = useState<'fhd' | '2k' | '4k'>('fhd');
  const [videoFps, setVideoFps] = useState<30 | 60>(30);
  const [videoBitrate, setVideoBitrate] = useState<'low' | 'medium' | 'high'>('medium');
  // Refs (not state): the hidden export canvas is mounted only while a video
  // export runs (see isExportingVideo below), so handleExport — an async
  // closure over one render — must read the nodes through refs, not stale state.
  const exportCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // M4.5b: last Pexels cue-computation inputs (diagnostics for the e2e only).
  const exportDiagRef = useRef<Record<string, unknown> | null>(null);
  const [isExportingVideo, setIsExportingVideo] = useState(false);
  // Cut-point times (seconds from export start) for the multi-clip Pexels
  // background — set by handleExport right before the export canvas mounts.
  const [exportBgCues, setExportBgCues] = useState<number[]>([]);
  // Ref mirror for the DEV hook (the hook closure is created once in a
  // mount-only effect, so it can only read refs, not render-fresh state).
  const exportBgCuesRef = useRef<number[]>([]);
  // DEV-only cue injection (e2e M4.5b): when set, handleExport uses these cues
  // instead of findPeakCuePoints — the flicker-regress tests frame fidelity,
  // not peak detection (covered by M4.5), and must be independent of the
  // mastering state earlier e2e sections may have left behind.
  const pexelsTestCuesRef = useRef<number[] | null>(null);
  // Audio clock for the cue math: track position minus the export start.
  const pexelsBgGetTime = () => Math.max(0, (audioEngine.current?.getCurrentTime() ?? 0) - exportStartRef.current);

  // Karaoke subtitles (v2.6): offline Whisper ASR over the export region.
  // Segment timings are seconds from the REGION START — the same clock as
  // pexelsBgGetTime, so the burn-in overlay and the SRT share one seam.
  const [karaokeOn, setKaraokeOn] = useState(false);
  const [asrState, setAsrState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [asrPhase, setAsrPhase] = useState<'loading' | 'loading-wasm' | 'transcribing'>('loading');
  const [asrError, setAsrError] = useState<string | null>(null);
  const [karaokeLines, setKaraokeLines] = useState<SubtitleSegment[] | null>(null);
  const [karaokeStyle, setKaraokeStyle] = useState<'karaoke' | 'subs'>('karaoke');

  // Pexels stock-video background states. Multi-clip: up to MAX_PEXELS_CLIPS
  // clips, rotation order = selection order (badge #1..#N in the UI).
  const [videoBgMode, setVideoBgMode] = useState<'visualizer' | 'pexels'>('visualizer');
  const [pexelsQuery, setPexelsQuery] = useState('');
  const [pexelsResults, setPexelsResults] = useState<PexelsClip[]>([]);
  const [pexelsSearching, setPexelsSearching] = useState(false);
  const [pexelsSelection, setPexelsSelection] = useState<PexelsSelectionItem[]>([]);
  const [pexelsError, setPexelsError] = useState<string | null>(null);
  // No API key ships with the app; the user pastes their own (localStorage only).
  const [pexelsKeyInput, setPexelsKeyInput] = useState(() => {
    try { return localStorage.getItem('nmp_pexels_key') || ''; } catch { return ''; }
  });
  const [pexelsHasKey, setPexelsHasKey] = useState(() => hasPexelsKey());
  const [showCredit, setShowCredit] = useState(true);
  // Refs: handleExport is an async closure over one render, so it reads the
  // selection through refs (same reason as exportCanvasRef above).
  const pexelsSelectionRef = useRef<PexelsSelectionItem[]>([]);
  const clipUrlMapRef = useRef<Map<number, string>>(new Map()); // clipId -> object URL (revocation)
  const selectionIdsRef = useRef<Set<number>>(new Set()); // selected clip ids, updated BEFORE state (in-flight guard)
  const clipDownloadQueueRef = useRef<Promise<unknown>>(Promise.resolve()); // sequential downloads (429-safe)
  const bgVideosRef = useRef<HTMLVideoElement[]>([]);
  const exportStartRef = useRef(0); // seconds of track time at the export start (audio clock origin)

  const audioEngine = useRef<AudioEngine | null>(null);
  const t = i18n[lang];

  useEffect(() => {
    pexelsSelectionRef.current = pexelsSelection;
    selectionIdsRef.current = new Set(pexelsSelection.map((s) => s.clip.id));
  }, [pexelsSelection]);

  // Revoke every clip object URL on unmount.
  useEffect(() => () => {
    clipUrlMapRef.current.forEach((url) => URL.revokeObjectURL(url));
    clipUrlMapRef.current.clear();
  }, []);

  // Derived (recomputed each render — the export JSX reads these, not the
  // handleExport closure's locals).
  const pexelsReadyItems = pexelsSelection.filter((s) => s.status === 'ready' && s.url);
  const pexelsReadyUrls = pexelsReadyItems.map((s) => s.url as string);
  const pexelsCreditNames = [...new Set(pexelsReadyItems.map((s) => s.clip.user.name))];

  useEffect(() => {
    audioEngine.current = new AudioEngine();
    audioEngine.current.setOnEnded(() => setIsPlaying(false));
    audioEngine.current.setOnError((msg) => showToast(msg, 'error'));
    
    // Apply default settings and initial monitoring mode immediately on init.
    // monitoringMode defaults to 'master' — the DSP chain is live from startup;
    // SOURCE/REFERENCE buttons bypass it for A/B.
    audioEngine.current.updateSettings(settings);
    audioEngine.current.setBypass(false);
    // (Time progress polling moved to <TimeControls> — see module scope.)

    // DEV-only hook for the browser E2E suite (scripts/e2e.cjs): exposes the
    // live engine so tests can read DSP param values and analyser snapshots,
    // plus a copy of the neutral settings (offline renderProPcm baselines).
    // import.meta.env.DEV is false in production builds → stripped there.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__NMP__ = {
        getEngine: () => audioEngine.current,
        getNeutralSettings: () => ({ ...NEUTRAL_SETTINGS }),
        // M4.5: live cut-point cues of the in-flight (or last) video export.
        getExportBgCues: () => exportBgCuesRef.current,
        // M4.5b diagnostics: bg mode (from the DOM — the seam closure can be
        // stale), selection statuses / cues (refs — always live).
        getPexelsDebug: () => ({
          mode: (() => {
            const r = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="videoBgMode"]')]
              .find((x) => x.checked);
            return r ? ((r.closest('label') || r.parentElement)?.textContent || '?').trim() : 'none-checked';
          })(),
          statuses: pexelsSelectionRef.current.map((s) => s.status),
          cues: exportBgCuesRef.current,
          exporting: !!exportCanvasRef.current,
          diag: exportDiagRef.current,
        }),
        // flicker probe (scripts/e2e-flicker.cjs): the detached bg <video>
        // elements of the mounted export canvas (readyState/currentTime).
        getBgVideos: () => bgVideosRef.current,
        // M1.14 (karaoke burn-in): inject subtitle lines WITHOUT running the
        // ASR model (timings in seconds from region start). null/[] clears.
        setKaraokeTestLines: (lines: Array<{ start: number; end: number; text: string }> | null) => {
          if (lines && lines.length) {
            setKaraokeLines(lines.map((l) => ({ start: l.start, end: l.end, text: l.text })));
            setKaraokeOn(true);
            setAsrState('done');
          } else {
            setKaraokeLines(null);
            setKaraokeOn(false);
            setAsrState('idle');
          }
          return true;
        },
        resetCoverOffset: () => { setCoverOffset({ x: 0, y: 0 }); return true; },
        // M4.5 (multi-clip Pexels export): injects fake "ready" selection
        // items pointing at in-page object URLs (synthetic webm clips), so
        // the whole cue/crossfade export path runs offline. [] clears.
        setPexelsTestSelection: (items: Array<{ url: string; author: string }>) => {
          clipUrlMapRef.current.forEach((url) => URL.revokeObjectURL(url));
          clipUrlMapRef.current.clear();
          selectionIdsRef.current.clear();
          const sel: PexelsSelectionItem[] = (items || []).map((it, i) => {
            const id = 9000 + i;
            const url = it.url || null;
            if (url) clipUrlMapRef.current.set(id, url);
            return {
              clip: { id, duration: 10, image: '', user: { name: it.author || 'Test Author', url: '' }, video_files: [] },
              file: { id, quality: 'hd', file_type: 'video/webm', width: 640, height: 360, fps: 30, link: it.url || '', size: 999999 },
              url,
              status: url ? 'ready' : 'error',
              progress: 1,
            };
          });
          setPexelsSelection(sel);
          return true;
        },
        // M4.5b (flicker regress): pin the cue list so the export's clip
        // rotation is deterministic regardless of the rendered master's
        // peak content. null restores peak detection.
        setPexelsTestCues: (cues: number[] | null) => {
          pexelsTestCuesRef.current = Array.isArray(cues) && cues.length > 0 ? cues.slice() : null;
          return true;
        },
      };
    }
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && audioEngine.current) {
      // Hard limit: decode + 4x true-peak analysis of bigger files is
      // impractical in the browser (memory + main-thread time).
      if (file.size > 200 * 1024 * 1024) {
        showToast(t.fileTooLarge, 'error');
        e.target.value = '';
        return;
      }

      setTrack(file);
      try {
        await audioEngine.current.loadTrack(file);
      } catch (err) {
        console.error('[NMP] Decode failed:', err);
        setTrack(null);
        setDuration(0);
        showToast(t.decodeFailed, 'error');
        return;
      }
      const dur = audioEngine.current.getDuration();
      setDuration(dur);
      setTrimStart(0);
      setTrimEnd(dur);
      hasAutoTrimRef.current = false;

      // Soft limit: analysis still works, just tell the user it may take a while
      if (file.size > 50 * 1024 * 1024 || dur > 20 * 60) {
        showToast(t.fileLargeWarn, 'warn');
      }

      // Force settings sync after track load specifically, just in case context wasn't ready
      audioEngine.current.updateSettings(settings);

      // Fresh track: drop old metrics, full analysis runs in the background
      setTrackMetrics(null);
      setTrackMetricsBusy(true);

      // Analyze original (async — real BS.1770-4 LUFS + LRA + tonal map)
      const snap = await audioEngine.current.analyzeBuffer(audioEngine.current.getBuffer(), (t as any).origTrack || "Original Track");
      if (snap) {
        setAnalysisLogs(prev => [...prev, snap]);
        setMetadata(prev => ({ ...prev, title: file.name.split('.')[0], bpm: snap.bpm ? Math.round(snap.bpm) : prev.bpm }));
      } else {
        setMetadata(prev => ({ ...prev, title: file.name.split('.')[0] }));
      }

      // The heavy true-peak/LUFS/tone pass (4× 256-tap FIR over the whole
      // buffer) runs in a web worker — it no longer touches the main thread,
      // so it can start immediately without stuttering playback start.
      // Engine boot races a fast upload: measureTrack early-returns while
      // Faust is still compiling, so wait (bounded) for readiness first.
      {
        const readyDeadline = Date.now() + 90_000;
        while (!audioEngine.current.isReady() && Date.now() < readyDeadline) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      audioEngine.current.cancelMeasure(); // drop any pass for a previous track
      const measureGen = ++measureGenRef.current;
      audioEngine.current.measureTrack(audioEngine.current.getBuffer())
        .then(m => { if (measureGen === measureGenRef.current && m) setTrackMetrics(m); })
        .finally(() => { if (measureGen === measureGenRef.current) setTrackMetricsBusy(false); });
    }
  };

  const handleRefUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && audioEngine.current) {
      setRefTrack(file);
      await audioEngine.current.loadReferenceTrack(file);
      
      // Update duration if we are currently in reference mode
      if (monitoringMode === 'reference') {
        setDuration(audioEngine.current.getRefBuffer()?.duration || 0);
      }

      // FIX: Analyzing the CORRECT buffer (refBuffer)
      const snap = await audioEngine.current.analyzeBuffer(audioEngine.current.getRefBuffer(), (t as any).refTrack || "Reference Track");
      if (snap) {
        setAnalysisLogs(prev => [...prev, snap]);
      }
    }
  };

  const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const url = ev.target?.result as string;
        setCoverArt(url);
        setCoverOffset({ x: 0, y: 0 });
        setCoverAspect(1);
        // Probe the natural size so we know whether panning is possible
        // (object-cover overflow only exists when aspect != 1:1).
        const probe = new Image();
        probe.onload = () => {
          if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
            setCoverAspect(probe.naturalWidth / probe.naturalHeight);
          }
        };
        probe.src = url;
      };
      reader.readAsDataURL(file);
    }
  };

  // Drag-to-pan the cover inside the frame. The drag math works in pixels
  // (maxPxX/Y = the object-cover overflow for the current box size), but the
  // result is stored normalized (-1..1) and rendered as a % transform of the
  // square element — so it is independent of box size and re-scales on
  // resize.
  const coverDragPossible = coverArt !== null && coverAspect !== 1;
  const onCoverPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!coverDragPossible) return;
    const el = e.currentTarget;
    const S = el.clientWidth;
    const maxPxX = coverAspect > 1 ? (S * (coverAspect - 1)) / 2 : 0;
    const maxPxY = coverAspect < 1 ? (S * (1 - coverAspect)) / (2 * coverAspect) : 0;
    if (maxPxX === 0 && maxPxY === 0) return;
    coverDragMovedRef.current = false;
    coverDragRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: coverOffset.x, oy: coverOffset.y, maxPxX, maxPxY };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-lost pointer: the drag still works because the
      // events are dispatched on the element itself.
    }
  };
  const onCoverPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const d = coverDragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) coverDragMovedRef.current = true;
    const nx = d.maxPxX > 0 ? Math.max(-1, Math.min(1, d.ox + dx / d.maxPxX)) : 0;
    const ny = d.maxPxY > 0 ? Math.max(-1, Math.min(1, d.oy + dy / d.maxPxY)) : 0;
    setCoverOffset({ x: nx, y: ny });
  };
  const onCoverPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    if (coverDragRef.current?.id === e.pointerId) coverDragRef.current = null;
  };
  // Preview transform as % of the square element: overflow fraction of the
  // box is (aspect-1)/2 horizontally (wide) or (1-aspect)/(2*aspect)
  // vertically (tall).
  const coverTransform = coverArt && coverAspect !== 1
    ? `translate(${coverAspect > 1 ? (coverOffset.x * (coverAspect - 1)) / 2 * 100 : 0}%, ${coverAspect < 1 ? (coverOffset.y * (1 - coverAspect)) / (2 * coverAspect) * 100 : 0}%)`
    : undefined;

  const togglePlayback = () => {
    if (!audioEngine.current || !track) return;
    if (isPlaying) {
      audioEngine.current.stop();
    } else {
      void audioEngine.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const setMonitoring = (mode: 'master' | 'source' | 'reference') => {
    setMonitoringMode(mode);
    if (!audioEngine.current) return;

    // Update duration for the timeline
    if (mode === 'reference') {
      const refDur = audioEngine.current.getRefBuffer()?.duration || 0;
      setDuration(refDur);
    } else {
      setDuration(audioEngine.current.getDuration());
    }

    if (mode === 'master') {
      audioEngine.current.setBypass(false);
      audioEngine.current.toggleReference(false);
    } else if (mode === 'source') {
      audioEngine.current.setBypass(true);
      audioEngine.current.toggleReference(false);
    } else if (mode === 'reference') {
      audioEngine.current.toggleReference(true);
    }
  };

  const handleSeek = (time: number) => {
    if (audioEngine.current) {
      audioEngine.current.seek(time);
      // <TimeControls> picks the new position up on its next 100 ms poll
      // (and updates optimistically on drag), so no App-level state needed.
    }
  };

  const handleVolumeChange = (val: number) => {
    setMonitorVolume(val);
    audioEngine.current?.setVolume(val);
  };

  const handleSpeedChange = (val: number) => {
    const newRate = getSpeed(val);
    const oldRate = getSpeed(playbackSpeed);
    setPlaybackSpeed(val);
    if (audioEngine.current) {
      audioEngine.current.setPlaybackRate(newRate);
      // Displayed BPM is track BPM × playback rate. Re-scale the measured
      // value instead of rescanning the buffer (analysis is now async and
      // heavy — a rescan on every slider tick would be wasteful).
      if (oldRate > 0) {
        setMetadata(m => m.bpm ? { ...m, bpm: Math.round(m.bpm * (newRate / oldRate)) } : m);
      }
    }
  };

  useEffect(() => {
    if (track && duration > 0 && !hasAutoTrimRef.current && settings !== NEUTRAL_SETTINGS) {
      setTrimEnd(duration);
      hasAutoTrimRef.current = true;
    }
  }, [settings, track, duration]);

  const updateSetting = (key: keyof MasteringSettings, value: number) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      audioEngine.current?.updateSettings(next);
      return next;
    });
  };

  const updateMultipleSettings = (updates: Partial<MasteringSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...updates };
      audioEngine.current?.updateSettings(next);
      return next;
    });
  };

  const setLlmConfig = (cfg: LlmConfig | null) => {
    setLlmConfigState(cfg);
    saveLlmConfig(cfg);
  };

  const showAutoMasterNote = (msg: string) => {
    setAutoMasterNote(msg);
    window.setTimeout(() => setAutoMasterNote(null), 6000);
  };

  const handleAutoMaster = async () => {
    setIsProcessing(true);
    try {
      let suggested: Partial<MasteringSettings> = {};
      if (llmConfig) {
        try {
          const r = await llmAutoMaster(llmConfig, metadata, analysisLogs, settings, trackMetrics);
          suggested = r.settings;
          if (r.explanation) showAutoMasterNote(r.explanation);
        } catch (e: any) {
          console.warn('[NMP] LLM Auto Master failed, using local algorithm:', e?.message || e);
          showAutoMasterNote((t as any).llmFallback || 'LLM failed — local algorithm used');
        }
      }
      if (Object.keys(suggested).length === 0) {
        suggested = await getAutoMasterSettings(metadata, analysisLogs);
      }
      const newSettings = { ...settings, ...suggested };
      setSettings(newSettings);
      audioEngine.current?.updateSettings(newSettings);

      // Analyze result diagnostic (RENDERED)
      setTimeout(async () => {
        if (audioEngine.current) {
          const snap = await audioEngine.current.analyzeProcessed((t as any).autoResult || "Auto-Mastered Result", newSettings);
          if (snap) {
            setAnalysisLogs(prev => [...prev, snap]);
            setShowLogs(true);
          }
        }
      }, 100);
    } catch (err) {
      console.error(err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAiReport = async () => {
    if (!llmConfig || aiReportBusy) return;
    setAiReportBusy(true);
    setAiReportError(null);
    try {
      setAiReport(await llmAiReport(llmConfig, analysisLogs, lang, trackMetrics));
    } catch (e: any) {
      const msg = e instanceof LlmError ? e.message : (e?.message || 'AI report failed');
      setAiReportError(msg);
      setAiReport(null);
    } finally {
      setAiReportBusy(false);
    }
  };

  const handleReset = () => {
    // Reset = everything inside the Pro panel block: the 81 module params,
    // the active save-slot, FX automation regions and A/B monitoring.
    // Track, trim, cover, metadata, reference and export options stay.
    setSettings(NEUTRAL_SETTINGS);
    audioEngine.current?.updateSettings(NEUTRAL_SETTINGS);
    setActivePresetIndex(1);
    setEffectRegions([]);
    // Without this the five FX sliders would stay in region-edit mode
    // (header "(Editing Area)") pointing at a region that no longer exists.
    setActiveFXRegionId(null);
    setMonitoring('master');
  };

  const handlePresetClick = (num: number) => {
    setActivePresetIndex(num);
    if (customPresets[num]) {
      setSettings(customPresets[num]);
      audioEngine.current?.updateSettings(customPresets[num]);
    }
  };

  const [isSavedFlash, setIsSavedFlash] = useState(false);

  const handleSavePreset = () => {
    const newPresets = { ...customPresets, [activePresetIndex]: settings };
    setCustomPresets(newPresets);
    localStorage.setItem('mastering_custom_presets', JSON.stringify(newPresets));
    setIsSavedFlash(true);
    setTimeout(() => setIsSavedFlash(false), 1500);
  };

  const isVert = videoOrientation === 'vertical';
  const baseW = videoRes === 'fhd' ? 1080 : videoRes === '2k' ? 1440 : 2160;
  const baseH = videoRes === 'fhd' ? 1920 : videoRes === '2k' ? 2560 : 3840;
  const expW = isVert ? baseW : baseH;
  const expH = isVert ? baseH : baseW;

  const clearPexelsSelection = () => {
    // Revoke happens here (outside any state updater — StrictMode double-runs
    // updaters in dev), guarded by the map so a double call is a no-op.
    clipUrlMapRef.current.forEach((url) => URL.revokeObjectURL(url));
    clipUrlMapRef.current.clear();
    // Immediate: in-flight .then callbacks check this before creating URLs.
    selectionIdsRef.current.clear();
    setPexelsSelection([]);
  };

  const resetPexelsSelection = () => {
    clearPexelsSelection();
    setPexelsResults([]);
    setPexelsError(null);
  };

  const runPexelsSearch = async () => {
    const q = pexelsQuery.trim();
    if (!q || pexelsSearching) return;
    if (!hasPexelsKey()) {
      setPexelsError(((t as any).pexelsNoKey || 'Add your Pexels API key to search — get one free at pexels.com/api'));
      return;
    }
    setPexelsSearching(true);
    setPexelsError(null);
    try {
      const results = await searchPexelsVideos(q, videoOrientation === 'vertical' ? 'portrait' : 'landscape');
      setPexelsResults(results);
      if (results.length === 0) {
        setPexelsError(((t as any).noVideosFound || 'No videos found for "{q}"').replace('{q}', q));
      }
    } catch (e: any) {
      const msg = e instanceof PexelsApiError ? ((t as any).pexelsError || 'Pexels error: {code}').replace('{code}', e.code) : (e?.message || 'Network error');
      setPexelsError(msg);
    } finally {
      setPexelsSearching(false);
    }
  };

  // Enqueue one clip download in the sequential queue (one fetch at a time —
  // Pexels rate-limits parallel requests with 429; ensureClipBlob still
  // dedupes by link hash and uses the file cache). Used by both first select
  // and per-card Retry.
  const queueClipDownload = (clip: PexelsClip, file: PexelsVideoFile) => {
    selectionIdsRef.current.add(clip.id);
    setPexelsSelection((prev) =>
      prev.some((s) => s.clip.id === clip.id)
        ? prev.map((s) => (s.clip.id === clip.id ? { ...s, file, status: 'downloading', progress: 0 } : s))
        : [...prev, { clip, file, url: null, status: 'downloading', progress: 0 }]
    );
    setPexelsError(null);
    clipDownloadQueueRef.current = clipDownloadQueueRef.current
      .catch(() => { /* a failed download must not poison the rest of the queue */ })
      .then(() => ensureClipBlob(file, (p) => {
        if (!selectionIdsRef.current.has(clip.id)) return; // deselected while queued
        setPexelsSelection((prev) => prev.map((s) => (s.clip.id === clip.id ? { ...s, progress: p } : s)));
      }))
      .then((blob) => {
        if (!selectionIdsRef.current.has(clip.id)) return; // deselected mid-download
        const url = URL.createObjectURL(blob);
        clipUrlMapRef.current.set(clip.id, url);
        setPexelsSelection((prev) => prev.map((s) => (s.clip.id === clip.id ? { ...s, url, status: 'ready', progress: 1 } : s)));
      })
      .catch((e: any) => {
        const msg = e instanceof PexelsApiError ? ((t as any).pexelsError || 'Pexels error: {code}').replace('{code}', e.code) : (e?.message || 'Download failed');
        setPexelsError(msg);
        setPexelsSelection((prev) => prev.map((s) => (s.clip.id === clip.id ? { ...s, status: 'error' } : s)));
      });
  };

  const handleClipToggle = (clip: PexelsClip) => {
    const selected = pexelsSelection.find((s) => s.clip.id === clip.id);
    if (selected) {
      const url = clipUrlMapRef.current.get(clip.id);
      if (url) URL.revokeObjectURL(url);
      clipUrlMapRef.current.delete(clip.id);
      selectionIdsRef.current.delete(clip.id);
      setPexelsSelection((prev) => prev.filter((s) => s.clip.id !== clip.id));
      return;
    }
    const file = pickBestRendition(clip.video_files, expW, expH);
    if (!file) {
      setPexelsError('No usable video file for this clip');
      return;
    }
    if (pexelsSelection.length >= MAX_PEXELS_CLIPS) {
      setPexelsError(((t as any).maxClips || 'Max {n} clips — deselect one first').replace('{n}', String(MAX_PEXELS_CLIPS)));
      return;
    }
    queueClipDownload(clip, file);
  };

  const handleClipRetry = (clip: PexelsClip) => {
    const item = pexelsSelection.find((s) => s.clip.id === clip.id);
    const file = item?.file ?? pickBestRendition(clip.video_files, expW, expH);
    if (!file) {
      setPexelsError('No usable video file for this clip');
      return;
    }
    queueClipDownload(clip, file);
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  // Stem export: four offline renders of the live chain, one per stem solo
  // (bass/vocal/mid/side). The exported stem is exactly what SOLO previews —
  // same crossover, same per-stem FX, same master-chain stages. Stems are
  // complementary bands (bass+vocal+mid sum to center, side is L−R); they are
  // not ML-isolated sources.
  const [stemsExportBusy, setStemsExportBusy] = useState(false);
  const handleExportStems = async () => {
    if (!track || !audioEngine.current || stemsExportBusy) return;
    setStemsExportBusy(true);
    try {
      const base = metadata.title || 'master';
      const entries: Record<string, Uint8Array> = {};
      for (const [stemName, soloIdx] of [['bass', 1], ['vocal', 2], ['mid', 3], ['side', 4]] as const) {
        const stemSettings = { ...settings, stem_solo: soloIdx };
        const pcm = await audioEngine.current.renderProPcm(
          stemSettings, Number(trimStart) || 0, Number(trimEnd) || 0, effectRegions
        );
        if (!pcm) throw new Error('Pro render failed — engine not ready');
        const enc = await encodeAudio(pcm.left, pcm.right, pcm.sampleRate, {
          format: 'wav',
          bitDepth: proWavBit,
          metadata,
        });
        entries[`${base}_${stemName}.wav`] = new Uint8Array(await enc.blob.arrayBuffer());
      }
      const zipped = zipSync(entries);
      downloadBlob(new Blob([zipped], { type: 'application/zip' }), `${base}_stems.zip`);
      showToast(`${(t as any).stemsExported || 'Stems exported'}: bass, vocal, mid, side`, 'warn');
    } catch (e) {
      showToast(`Stems export failed: ${(e as Error).message}`, 'error');
    } finally {
      setStemsExportBusy(false);
    }
  };

  // Whisper ASR over the export region (offline, in a module worker). The
  // region PCM is rendered exactly like the cue pass — same input, same
  // timing seam. Music ASR is imperfect by nature; the UI lets the user fix
  // every line before export.
  const handleRecognizeLyrics = async () => {
    if (!track || !audioEngine.current) return;
    setAsrState('running');
    setAsrError(null);
    setAsrPhase('loading');
    try {
      const pcm = await audioEngine.current.renderProPcm(
        settings, Number(trimStart) || 0, Number(trimEnd) || 0, effectRegions
      );
      if (!pcm) throw new Error('render failed');
      const n = Math.min(pcm.left.length, pcm.right.length);
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i += 1) mono[i] = (pcm.left[i] + pcm.right[i]) * 0.5;
      const segs = await recognizeLyrics(mono, pcm.sampleRate, (s) => setAsrPhase(s.phase));
      if (!segs.length) {
        setAsrState('error');
        setAsrError((t as any).asrNoLyrics || 'No lyrics detected in this region');
        return;
      }
      setKaraokeLines(segs);
      setAsrState('done');
    } catch (e) {
      setAsrState('error');
      setAsrError(`ASR: ${(e as Error).message}`);
    }
  };

  const handleExport = async () => {
    if (!track || !audioEngine.current || (!exportAudio && !exportVideo)) return;
    if (exportVideo && karaokeOn && !karaokeLines) {
      showToast((t as any).needLines || 'Recognize lyrics before exporting with subtitles', 'warn');
      return;
    }
    setIsProcessing(true);

    try {
      const fileNameBase = metadata.title || 'master';

      // The offline master mix, rendered at most once: the audio export uses
      // it directly, and the Pexels cue pass (below) reuses it instead of
      // rendering the trim a second time.
      let masterPcm: { left: Float32Array; right: Float32Array; sampleRate: number } | null = null;

      if (exportAudio) {
        // Offline Faust render → shared encoder (dithered WAV / MP3 / FLAC / AAC + metadata).
        masterPcm = await audioEngine.current.renderProPcm(settings, Number(trimStart) || 0, Number(trimEnd) || 0, effectRegions);
        if (!masterPcm) throw new Error('Pro render failed — engine not ready');
        const enc = await encodeAudio(masterPcm.left, masterPcm.right, masterPcm.sampleRate, {
          format: exportFormat,
          bitDepth: exportFormat === 'wav' ? proWavBit : undefined,
          aacKbps: exportFormat === 'aac' ? aacKbps : undefined,
          metadata,
        });
        downloadBlob(enc.blob, `${fileNameBase}_NeuralMaster.${enc.ext}`);
      }

      if (exportVideo) {
        // Honor the trim region: start at trimStart, record to trimEnd (capped at track end).
        // Computed FIRST: the Pexels cue pass below needs the region length.
        const recStart = Math.min(Number(trimStart) || 0, duration);
        const recEnd = Math.min(Number(trimEnd) || 0, duration) || duration;
        const recLenSec = Math.max(0, recEnd - recStart);

        // Pexels multi-clip background: drain the download queue (clips still
        // fetching), then compute the cut cues from the MASTER mix PCM — the
        // exact audio that lands in the export. 2+ ready clips → cues; 1 clip
        // → single loop; 0 → the plain visualizer (readyVids guard in the
        // draw loop degrades on the fly).
        const isPexelsBg = videoBgMode === 'pexels';
        if (isPexelsBg) {
          await clipDownloadQueueRef.current.catch(() => {});
        }
        const readySel = isPexelsBg
          ? pexelsSelectionRef.current.filter((s) => s.status === 'ready' && s.url)
          : [];
        let bgCues: number[] = [];
        if (pexelsTestCuesRef.current) {
          bgCues = pexelsTestCuesRef.current; // e2e M4.5b pinned cues
        } else if (readySel.length >= 2) {
          const pcm = masterPcm ?? await audioEngine.current.renderProPcm(
            settings, Number(trimStart) || 0, Number(trimEnd) || 0, effectRegions
          );
          if (pcm) {
            const regionSec = Math.min(recLenSec, pcm.left.length / pcm.sampleRate);
            bgCues = findPeakCuePoints(pcm.left, pcm.right, pcm.sampleRate, 0, regionSec);
          }
        }
        // M4.5b diagnostics (scripts/e2e-flicker-regress.cjs): why bgCues came
        // out the way it did — surfaces readySel/pcm/trim state at click time.
        // expT: wall/engine timing of the capture pipeline — the full suite
        // lost the first ~1.9 s of the region in the FILE while the canvas
        // painted it perfectly; these markers pinpoint where.
        const expT: Record<string, number> = {};
        const engNow = () => Math.round((audioEngine.current?.getCurrentTime() ?? 0) * 100) / 100;
        exportDiagRef.current = {
          isPexelsBg, readySel: readySel.length, statuses: pexelsSelectionRef.current.map((s) => s.status),
          exportAudio, trimStart: Number(trimStart) || 0, trimEnd: Number(trimEnd) || 0,
          recLenSec, masterPcm: !!masterPcm, pcmOk: bgCues.length > 0, cues: bgCues.length,
          seam: !!pexelsTestCuesRef.current, t: expT
        };
        setExportBgCues(bgCues);
        exportBgCuesRef.current = bgCues;
        exportStartRef.current = recStart;

        // Mount the hidden high-res canvas only for the duration of the export.
        // It was always-mounted before: up to a 2160×3840 canvas drawing every
        // frame during normal playback (the visualizer rendered twice).
        // Drop the PREVIOUS export's canvas first — onCanvasReady only sets the
        // ref, and if the stale (detached, un-drawn) element were still in it,
        // the poll below would return immediately and captureStream would
        // record the dead canvas (black frames although the live canvas paints).
        exportCanvasRef.current = null;
        setIsExportingVideo(true);
        await new Promise<void>((resolve) => {
          const t0 = Date.now();
          const poll = () =>
            exportCanvasRef.current || Date.now() - t0 > 3000
              ? resolve()
              : setTimeout(poll, 50);
          poll();
        });
        if (!exportCanvasRef.current) {
          setIsExportingVideo(false);
          throw new Error('Export canvas failed to mount');
        }
        // `as` is needed: the ref-reset above makes TS narrow .current to null,
        // the poll + onCanvasReady refill are invisible to control-flow typing.
        const exportCanvas = exportCanvasRef.current as HTMLCanvasElement;

        // Pexels backgrounds: wait for first frames (up to 8 s) BEFORE the
        // audio starts — otherwise the clips and the track desync. The
        // <video> elements are created by the visualizer effect once the
        // export canvas mounts and are reported via onBgVideosReady. A clip
        // that never becomes ready drops out of the rotation inside the
        // visualizer (readyVids filter); the cues stay valid for the rest.
        if (readySel.length > 0) {
          const waitStart = Date.now();
          while (
            (bgVideosRef.current.length < readySel.length || bgVideosRef.current.some((v) => v.readyState < 2))
            && Date.now() - waitStart < 8000
          ) {
            await new Promise(r => setTimeout(r, 100));
          }
          bgVideosRef.current.forEach((v) => {
            if (v.readyState >= 1) v.currentTime = 0;
            v.play().catch(() => {});
          });
        }

        // Record the processed MASTER regardless of the current monitor/bypass —
        // otherwise a user monitoring the dry source exports unprocessed audio.
        const savedBypass = audioEngine.current.getBypass();
        if (savedBypass) {
          audioEngine.current.setBypass(false);
          await new Promise(r => setTimeout(r, 150)); // let the 20 ms switch gains settle
        }

        audioEngine.current.seek(recStart);
        // The context must be fully running before captureStream/record — but
        // the RESUME alone must not sit between play and recorder.start: under
        // load it can block for seconds, and everything the engine plays in
        // that window never reaches the file (export starts 2 s late). Warm
        // the context here (no source started yet), start the recorder, and
        // only then start playback.
        await audioEngine.current.getAudioContext().resume();
        expT.tResume = Date.now(); expT.eResume = engNow();

        const dest = audioEngine.current.getAudioContext().createMediaStreamDestination();
        audioEngine.current.getMonitorGain().connect(dest);

        const videoStream = exportCanvas.captureStream(videoFps);
        const combinedStream = new MediaStream([
          ...videoStream.getVideoTracks(),
          ...dest.stream.getAudioTracks()
        ]);

        let mimeType = 'video/webm';
        if (MediaRecorder.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')) {
           mimeType = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
        } else if (MediaRecorder.isTypeSupported('video/webm; codecs="h264,opus"')) {
           mimeType = 'video/webm; codecs="h264,opus"';
        }
        
        let bps = 10000000;
        let pM = 1;
        if (videoRes === '2k') pM = 2;
        if (videoRes === '4k') pM = 4;
        
        let baseM = 10;
        if (videoFps === 60) {
           if (videoBitrate === 'low') baseM = 10;
           if (videoBitrate === 'medium') baseM = 20;
           if (videoBitrate === 'high') baseM = 30;
        } else {
           if (videoBitrate === 'low') baseM = 5;
           if (videoBitrate === 'medium') baseM = 10;
           if (videoBitrate === 'high') baseM = 15;
        }
        bps = baseM * pM * 1024 * 1024;

        const recorder = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: bps });
        expT.tRec = Date.now(); expT.eRec = engNow();
        const chunks: BlobPart[] = [];
        recorder.ondataavailable = e => {
          if (e.data.size) {
            if (!expT.tData) { expT.tData = Date.now(); expT.eData = engNow(); expT.nData = e.data.size; }
            chunks.push(e.data);
          }
        };
        
        const videoPromise = new Promise<void>((resolve, reject) => {
          let reqId: number;
          if (exportCanvas) {
            const ctx = exportCanvas.getContext('2d');
            const forceDraw = () => {
              if (ctx) {
                const pd = ctx.getImageData(0,0,1,1);
                ctx.putImageData(pd,0,0);
              }
              reqId = requestAnimationFrame(forceDraw);
            };
            reqId = requestAnimationFrame(forceDraw);
          }

          recorder.onstop = () => {
            if (reqId) cancelAnimationFrame(reqId);
            try {
              const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
              expT.tStopDone = Date.now(); expT.blobSize = blob.size;
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.style.display = 'none';
              a.href = url;
              let ext = 'webm';
              if (mimeType.includes('mp4')) ext = 'mp4';
              else if (mimeType.includes('matroska')) ext = 'mkv';
              
              a.download = `${fileNameBase}_NeuralMaster.${ext}`;
              document.body.appendChild(a);
              a.click();
              window.URL.revokeObjectURL(url);
              resolve();
            } catch(e) { reject(e); }
          };
          recorder.onerror = (e) => {
             if (reqId) cancelAnimationFrame(reqId);
             // e is a raw ErrorEvent — rejecting with it made the failure an
             // undiagnosable "[object ErrorEvent]" in the console. e.error is
             // the underlying DOMException.
             reject((e as ErrorEvent).error ?? new Error('MediaRecorder error'));
          };
        });

        recorder.start(100); // 100ms chunks to stop 4K freezing and OOM!
        expT.tStart = Date.now(); expT.eStart = engNow();

        // Playback starts AFTER the recorder is live: whatever the source
        // start costs (context already resumed above), no region content can
        // be lost between play and start. A possible short pre-roll shows as
        // moving clip frames (bg videos already play), never as black/freeze.
        try {
          await audioEngine.current.play();
        } catch (e) {
          try { recorder.stop(); } catch { /* already inactive */ }
          videoStream.getTracks().forEach((tr) => tr.stop());
          dest.stream.getTracks().forEach((tr) => tr.stop());
          throw e;
        }
        setIsPlaying(true);
        expT.tPlay = Date.now(); expT.ePlay = engNow();

        const ms = recLenSec * 1000;
        await new Promise(r => setTimeout(r, ms + 100)); // wait for the trimmed region to play

        expT.tStop = Date.now(); expT.eStop = engNow(); expT.chunks = chunks.length;
        recorder.stop();
        bgVideosRef.current.forEach((v) => v.pause());
        // With trimEnd < track end the source is still playing — stop it and
        // restore the user's monitor mode.
        audioEngine.current.stop();
        audioEngine.current.getMonitorGain().disconnect(dest);
        audioEngine.current.setBypass(savedBypass);
        setIsPlaying(false);
        // Release the capture: canvas tracks left "live" keep requesting
        // frames from the unmounted export canvas forever and break the
        // canvas-capture pipeline of the NEXT export (black frames recorded
        // although the canvas paints correctly) — plus leak encoders.
        await videoPromise.finally(() => {
          videoStream.getTracks().forEach((tr) => tr.stop());
          dest.stream.getTracks().forEach((tr) => tr.stop());
        });
        setIsExportingVideo(false);
        // Karaoke: the .srt lands right after the video (same base name).
        if (karaokeOn && karaokeLines) {
          downloadBlob(
            new Blob([segmentsToSrt(karaokeLines)], { type: 'text/plain;charset=utf-8' }),
            `${fileNameBase}_NeuralMaster.srt`
          );
        }
      }

      setShowDone(true);
      setTimeout(() => setShowDone(false), 3000);
    } catch (err) {
      console.error("Export failed", err);
      if (exportAudio && exportFormat === 'aac') {
        setAacState('error');
        showToast(t.aacError);
      }
      setIsExportingVideo(false);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--bg)] font-sans">
      {/* Hidden high-res canvas for video export — mounted ONLY while an
          export runs. Always-mounted before, it cost a full 2160×3840 paint
          per frame during normal playback (B1). */}
      {isExportingVideo && (
        <div style={{ position: 'fixed', top: '-9999px', left: '-9999px', opacity: 0.01, pointerEvents: 'none' }}>
          <AudioVisualizer
            analyser={audioEngine.current?.getAnalysers()?.L || null}
            mode={visMode}
            coverArt={coverArt || './logo_Neural Master Pro.png'}
            coverOffset={coverOffset}
            width={expW}
            height={expH}
            exportMode={true}
            metadata={metadata}
            onCanvasReady={(c) => { exportCanvasRef.current = c; }}
            bgVideoUrls={videoBgMode === 'pexels' ? pexelsReadyUrls : null}
            bgCueTimes={videoBgMode === 'pexels' ? exportBgCues : null}
            bgGetTime={pexelsBgGetTime}
            creditText={videoBgMode === 'pexels' && showCredit && pexelsCreditNames.length > 0
              ? `${(t as any).videoAuthor || 'Video:'} Pexels / ${pexelsCreditNames.join(', ')}`
              : null}
            onBgVideosReady={(vs) => { bgVideosRef.current = vs; }}
            karaoke={karaokeOn && karaokeLines ? { segments: karaokeLines, style: karaokeStyle } : null}
            karaokeGetTime={pexelsBgGetTime}
          />
        </div>
      )}

      {/* Header */}
      <header className="h-[60px] bg-[var(--panel)] border-b border-[var(--border)] flex items-center justify-between px-6 shrink-0 relative" style={{ WebkitAppRegion: 'drag' } as any}>
        <div className="flex items-center gap-3 w-1/3">
          <div className="w-[42px] h-[42px] flex flex-col items-center justify-center">
            <img ref={logoRef} src="./logo_Neural Master Pro.png" alt="NMP Logo" className="w-[32px] h-[32px] object-contain drop-shadow-[0_0_8px_rgba(0,255,255,0.8)]" onError={(e) => e.currentTarget.style.display = 'none'} />
          </div>
          <div className="text-[18px] font-extrabold uppercase tracking-[2px] text-[var(--accent)]">
            Neural Master Pro
          </div>
          <div className="flex bg-black border border-[var(--border)] p-0.5 rounded-sm ml-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <button
              onClick={() => switchMode('lite')}
              className={cn(
                "px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest rounded-sm transition-colors",
                appMode === 'lite' ? "bg-[var(--accent)] text-black" : "text-[var(--text-dim)] hover:text-white"
              )}
            >
              {t.modeLite}
            </button>
            <button
              onClick={() => switchMode('pro')}
              className={cn(
                "px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest rounded-sm transition-colors border-l border-white/5",
                appMode === 'pro' ? "bg-[var(--accent)] text-black" : "text-[var(--text-dim)] hover:text-white"
              )}
            >
              {t.modePro}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-center gap-4 w-1/3" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {/* CPU Monitor */}
          <label className="flex items-center gap-2 bg-[#0a0a0c] border border-[var(--border)] px-3 py-1.5 rounded-sm cursor-pointer hover:bg-[#1a1c22] transition-colors relative min-w-[210px]">
            <input type="radio" name="renderDevice" checked={processingMode === 'cpu'} onChange={() => setProcessingMode('cpu')} className="accent-[var(--accent)] cursor-pointer" />
            <div className="flex flex-col flex-1 min-w-0">
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={cn("w-1.5 h-1.5 rounded-full shrink-0 shadow-[0_0_5px]", (cpuTemp || 0) > 80 ? "bg-red-500 shadow-red-500 animate-[pulse_0.5s_infinite]" : "bg-[var(--accent)] shadow-[var(--accent)]")} />
                  <span className="text-[10px] font-bold text-white tracking-wider truncate" title={cpuName}>{cpuName}</span>
                </div>
                <div className="flex items-center gap-1.5 ml-2 shrink-0">
                  {cpuLoad !== null && <span className="text-[9px] font-mono text-[#666] bg-[#111] px-1 rounded-sm border border-[#222] min-w-[24px] text-center">{Math.round(cpuLoad)}%</span>}
                  <span className={cn("text-[10px] font-mono", (cpuTemp || 0) > 80 ? "text-red-500" : "text-[var(--text-dim)]")}>{cpuTemp !== null ? `${Math.round(cpuTemp)}°C` : '--°C'}</span>
                </div>
              </div>
              {(cpuTemp || 0) > 80 && <span className="text-[8px] text-red-500 font-bold uppercase animate-pulse absolute -bottom-3 left-6">{(t as any).overheating}</span>}
            </div>
          </label>

          {/* GPU Monitor */}
          <label className="flex items-center gap-2 bg-[#0a0a0c] border border-[var(--border)] px-3 py-1.5 rounded-sm cursor-pointer hover:bg-[#1a1c22] transition-colors relative min-w-[210px]">
            <input type="radio" name="renderDevice" checked={processingMode === 'gpu'} onChange={() => setProcessingMode('gpu')} className="accent-[var(--accent)] cursor-pointer" />
            <div className="flex flex-col flex-1 min-w-0">
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={cn("w-1.5 h-1.5 rounded-full shrink-0 shadow-[0_0_5px]", (gpuTemp || 0) > 80 ? "bg-red-500 shadow-red-500 animate-[pulse_0.5s_infinite]" : "bg-[var(--accent)] shadow-[var(--accent)]")} />
                  <span className="text-[10px] font-bold text-white tracking-wider truncate" title={gpuName}>{gpuName}</span>
                </div>
                <div className="flex items-center gap-1.5 ml-2 shrink-0">
                  {gpuLoad !== null && <span className="text-[9px] font-mono text-[#666] bg-[#111] px-1 rounded-sm border border-[#222] min-w-[24px] text-center">{Math.round(gpuLoad)}%</span>}
                  <span className={cn("text-[10px] font-mono", (gpuTemp || 0) > 80 ? "text-red-500" : "text-[var(--text-dim)]")}>{gpuTemp !== null ? `${Math.round(gpuTemp)}°C` : '--°C'}</span>
                </div>
              </div>
              {(gpuTemp || 0) > 80 && <span className="text-[8px] text-red-500 font-bold uppercase animate-pulse absolute -bottom-3 left-6">{(t as any).overheating}</span>}
            </div>
          </label>

          <button
            onClick={() => setShowLogs(!showLogs)}
            className={cn(
              "p-2 rounded-sm transition-all border ml-2",
              showLogs ? "bg-[var(--accent)]/10 border-[var(--accent)] text-[var(--accent)]" : "bg-black border-[var(--border)] text-[var(--text-dim)] hover:text-white"
            )}
            title="Toggle Calibration Logs"
          >
            <Settings2 size={18} />
          </button>

          <button
            onClick={() => setShowLlmSettings(true)}
            className={cn(
              "p-2 rounded-sm transition-all border",
              llmConfig ? "bg-[var(--accent)]/10 border-[var(--accent)] text-[var(--accent)]" : "bg-black border-[var(--border)] text-[var(--text-dim)] hover:text-white"
            )}
            title={llmConfig ? ((t as any).llmSettings || "Neural Engine") : ((t as any).llmNotConfigured || "No neural engine — local algorithm used")}
          >
            <Cpu size={18} />
          </button>
        </div>
        
        <div className="flex items-center justify-end w-1/3 gap-3" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button 
             onClick={() => {
               if (typeof window !== 'undefined' && (window as any).nmpIpc) {
                 (window as any).nmpIpc.minimize();
               }
             }}
             className="text-[var(--text-dim)] hover:text-white p-2 transition-colors"
          >
             <Minus size={16} />
          </button>
          
          <button 
            onClick={() => {
              if (document.fullscreenElement) {
                document.exitFullscreen();
              } else {
                document.documentElement.requestFullscreen();
              }
            }}
            className="text-[var(--text-dim)] hover:text-white p-2 transition-colors"
          >
             <Maximize size={16} />
          </button>
          
          <button 
             onClick={() => {
               if (typeof window !== 'undefined' && (window as any).nmpIpc) {
                 (window as any).nmpIpc.close();
               } else {
                 window.close();
               }
             }}
             className="text-[var(--text-dim)] hover:text-red-500 p-2 transition-colors"
          >
             <X size={18} />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className={cn("flex-1 grid bg-[var(--border)] overflow-hidden", appMode === 'lite' ? "grid-cols-[1fr_280px]" : "grid-cols-[280px_1fr_280px]")}>
        {/* Left: Mastering Modules (Pro only) */}
        <aside className={appMode === 'lite' ? 'hidden' : "bg-[var(--panel)] p-4 overflow-y-auto space-y-6 border-r border-black/40 shadow-[10px_0_30px_rgba(0,0,0,0.3)] z-10 w-[300px]"}>
          <div className="flex items-center justify-between mb-2 px-1">
            <div className="flex flex-col">
              <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--accent)]">{t.chains}</span>
              <div className="flex items-center gap-1.5 mt-1">
                <div className={cn("w-1.5 h-1.5 rounded-full transition-all duration-500", isEngineReady ? "bg-[var(--accent)] text-[var(--accent)] shadow-[0_0_8px_var(--accent)]" : "bg-orange-500 text-orange-500 animate-pulse shadow-[0_0_8px_currentColor] shadow-orange-500/50")} />
                <span className="text-[9px] font-mono text-[var(--text-dim)] uppercase tracking-tighter">
                  {isEngineReady ? t.engineReady : t.engineInitializing}
                </span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <button 
                onClick={handleAutoMaster}
                disabled={!track || !refTrack || isProcessing || !isEngineReady}
                className="text-[9px] font-bold uppercase tracking-widest text-[var(--accent)] hover:brightness-125 disabled:opacity-30 disabled:grayscale flex items-center gap-1"
                title={!refTrack ? "Requires Reference Track" : ""}
              >
                <Sparkles size={10} /> {t.autoMaster}
              </button>
              <button 
                onClick={handleReset}
                disabled={!track || isProcessing}
                className="text-[9px] font-bold text-[var(--text-dim)] hover:text-white uppercase tracking-widest"
              >
                {t.reset}
              </button>
            </div>
          </div>

          <div className="space-y-8 pb-10">
            {/* TONAL GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.tonal}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>

              {/* Custom Presets Row */}
              <div className="flex flex-col gap-2 mb-2 bg-[#111216] border border-[#222328] rounded-md p-2 shadow-inner">
                 <span className="text-[8px] font-bold uppercase tracking-[0.1em] text-[#666]">{(t as any).presets || "Presets"}</span>
                 <div className="flex items-center justify-between gap-2">
                   <div className="flex gap-1.5">
                     {[1,2,3,4,5].map(num => (
                       <button
                         key={num}
                         onClick={() => handlePresetClick(num)}
                         className={cn(
                           "w-6 h-6 flex items-center justify-center rounded-sm text-[10px] font-bold transition-colors border",
                           activePresetIndex === num 
                             ? "bg-[var(--accent)] border-[var(--accent)] text-black" 
                             : customPresets[num] 
                               ? "bg-[#222] border-[#444] text-white hover:border-[var(--accent)]" 
                               : "bg-black border-[#222] text-[#555] hover:text-[#999] hover:bg-[#111]"
                         )}
                         title={customPresets[num] ? `Load Preset ${num}` : `Select Slot ${num}`}
                       >
                         {num}
                       </button>
                     ))}
                   </div>
                   <button 
                     onClick={handleSavePreset}
                     disabled={!track || isProcessing || !isEngineReady}
                     className={cn(
                       "text-[9px] px-3 py-1.5 border uppercase font-bold tracking-widest rounded-sm disabled:opacity-30 transition-all flex items-center gap-1 whitespace-nowrap",
                       isSavedFlash 
                         ? "bg-green-500 border-green-500 text-black outline-none shadow-[0_0_10px_rgba(34,197,94,0.5)]" 
                         : "bg-black border-[#444] hover:border-[var(--accent)] hover:text-[#fff] text-[var(--text-dim)]"
                     )}
                     title={`Save to slot ${activePresetIndex}`}
                   >
                     {isSavedFlash ? <CheckCircle2 size={12} /> : null}
                     {isSavedFlash ? (t.done || "Saved") : ((t as any).savePreset || "Save")}
                   </button>
                 </div>
              </div>

              <MasteringControl 
                label={t.gain} 
                value={settings.gain} 
                min={-18} max={18} step={0.01} 
                onChange={(v) => updateSetting('gain', v)} 
                tooltip={t.gainTip}
                unit="dB"
                disabled={monitoringMode !== 'master'}
              />
              <div className="grid grid-cols-1 gap-3">
                <MasteringControl 
                  label={t.low} 
                  value={settings.lowShelf} 
                  min={-10} max={10} step={0.01} 
                  onChange={(v) => updateSetting('lowShelf', v)} 
                  tooltip={t.lowTip}
                  unit="dB"
                  disabled={monitoringMode !== 'master'}
                />
                <MasteringControl 
                  label={t.mid} 
                  value={settings.midRange} 
                  min={-10} max={10} step={0.01} 
                  onChange={(v) => updateSetting('midRange', v)} 
                  tooltip={t.midTip}
                  unit="dB"
                  disabled={monitoringMode !== 'master'}
                />
                <MasteringControl 
                  label={t.high} 
                  value={settings.highShelf} 
                  min={-10} max={10} step={0.01} 
                  onChange={(v) => updateSetting('highShelf', v)} 
                  tooltip={t.highTip}
                  unit="dB"
                  disabled={monitoringMode !== 'master'}
                />
                <MasteringControl
                  label={t.fundamental}
                  value={settings.fundamentalFreq}
                  min={20} max={200} step={0.01}
                  onChange={(v) => updateSetting('fundamentalFreq', v)}
                  tooltip={t.fundamentalTip}
                  unit="Hz"
                  resetValue={60}
                  disabled={monitoringMode !== 'master'}
                />
              </div>
            </div>

            {/* PARAMETRIC EQ GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.peq}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <ParametricEQ
                settings={settings}
                onChange={updateSetting}
                disabled={monitoringMode !== 'master'}
                t={t}
              />
            </div>

            {/* DYNAMICS GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.dynamics}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <MasteringControl 
                label={t.compression} 
                value={settings.compression} 
                min={-5} max={5} step={0.01} 
                onChange={(v) => updateSetting('compression', v)} 
                tooltip={t.compressionTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.limiter}
                value={settings.limiter}
                min={-5} max={5} step={0.01}
                onChange={(v) => updateSetting('limiter', v)}
                tooltip={t.limiterTip}
                unit="dB"
                disabled={monitoringMode !== 'master'}
              />
            </div>

            {/* COMPRESSOR GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.comp}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <MasteringControl
                label={t.compAmount}
                value={settings.compAmt}
                min={0} max={100} step={0.1}
                onChange={(v) => updateSetting('compAmt', v)}
                tooltip={t.compAmountTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.compThresh}
                value={settings.compThresh}
                min={-40} max={0} step={0.5}
                onChange={(v) => updateSetting('compThresh', v)}
                tooltip={t.compThreshTip}
                unit="dB"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.compRatio}
                value={settings.compRatio}
                min={1} max={20} step={0.1}
                onChange={(v) => updateSetting('compRatio', v)}
                tooltip={t.compRatioTip}
                unit="x"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.compAttack}
                value={settings.compAttack}
                min={1} max={100} step={1}
                onChange={(v) => updateSetting('compAttack', v)}
                tooltip={t.compAttackTip}
                unit="ms"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.compRelease}
                value={settings.compRelease}
                min={30} max={500} step={1}
                onChange={(v) => updateSetting('compRelease', v)}
                tooltip={t.compReleaseTip}
                unit="ms"
                disabled={monitoringMode !== 'master'}
              />
            </div>

            {/* NOISE GATE GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.gate}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <MasteringControl
                label={t.gateAmount}
                value={settings.gateAmt}
                min={0} max={100} step={0.1}
                onChange={(v) => updateSetting('gateAmt', v)}
                tooltip={t.gateAmountTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.gateThreshold}
                value={settings.gateThresh}
                min={-60} max={0} step={0.5}
                onChange={(v) => updateSetting('gateThresh', v)}
                tooltip={t.gateThresholdTip}
                unit="dB"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.gateRelease}
                value={settings.gateRelease}
                min={20} max={500} step={1}
                onChange={(v) => updateSetting('gateRelease', v)}
                tooltip={t.gateReleaseTip}
                unit="ms"
                disabled={monitoringMode !== 'master'}
              />
            </div>

            {/* TRANSIENT SHAPER GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.trans}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <MasteringControl
                label={t.transAmount}
                value={settings.transAmt}
                min={-100} max={100} step={0.1}
                onChange={(v) => updateSetting('transAmt', v)}
                tooltip={t.transAmountTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.transFreq}
                value={settings.transFreq}
                min={50} max={1000} step={1}
                onChange={(v) => updateSetting('transFreq', v)}
                tooltip={t.transFreqTip}
                unit="Hz"
                disabled={monitoringMode !== 'master'}
              />
            </div>

            {/* DE-ESSER GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.deess}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <MasteringControl
                label={t.deessAmount}
                value={settings.deessAmt}
                min={0} max={100} step={0.1}
                onChange={(v) => updateSetting('deessAmt', v)}
                tooltip={t.deessAmountTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.deessFreq}
                value={settings.deessFreq}
                min={4000} max={9000} step={50}
                onChange={(v) => updateSetting('deessFreq', v)}
                tooltip={t.deessFreqTip}
                unit="Hz"
                disabled={monitoringMode !== 'master'}
              />
            </div>

            {/* TEXTURE GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.texture}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <div className="grid grid-cols-1 gap-3">
                <MasteringControl 
                  label={t.saturation} 
                  value={settings.saturation} 
                  min={-10} max={10} step={0.01} 
                  onChange={(v) => updateSetting('saturation', v)} 
                  tooltip={t.saturationTip}
                  unit="LVL"
                  disabled={monitoringMode !== 'master'}
                />
                <MasteringControl 
                  label={t.exciter} 
                  value={settings.exciterAmount} 
                  min={-10} max={10} step={0.01} 
                  onChange={(v) => updateSetting('exciterAmount', v)} 
                  tooltip={t.exciterTip}
                  unit="LVL"
                  disabled={monitoringMode !== 'master'}
                />
              </div>
            </div>

            {/* TAPE SATURATION GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.tape}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <MasteringControl
                label={t.tapeAmount}
                value={settings.tapeAmt}
                min={0} max={100} step={0.1}
                onChange={(v) => updateSetting('tapeAmt', v)}
                tooltip={t.tapeAmountTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.tapeTone}
                value={settings.tapeTone}
                min={1000} max={12000} step={50}
                onChange={(v) => updateSetting('tapeTone', v)}
                tooltip={t.tapeToneTip}
                unit="Hz"
                disabled={monitoringMode !== 'master'}
              />
            </div>

            {/* AIR EXCITER GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.air}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <MasteringControl
                label={t.airAmount}
                value={settings.airAmt}
                min={0} max={100} step={0.1}
                onChange={(v) => updateSetting('airAmt', v)}
                tooltip={t.airAmountTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.airFreq}
                value={settings.airFreq}
                min={5000} max={12000} step={50}
                onChange={(v) => updateSetting('airFreq', v)}
                tooltip={t.airFreqTip}
                unit="Hz"
                disabled={monitoringMode !== 'master'}
              />
            </div>

            {/* BITCRUSHER GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.crush}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <MasteringControl
                label={t.bitDepth}
                value={settings.bitDepth}
                min={4} max={16} step={1}
                onChange={(v) => updateSetting('bitDepth', v)}
                tooltip={t.bitDepthTip}
                unit="bit"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.srHold}
                value={settings.srHold}
                min={1} max={20} step={1}
                onChange={(v) => updateSetting('srHold', v)}
                tooltip={t.srHoldTip}
                unit="x"
                disabled={monitoringMode !== 'master'}
              />
            </div>

            {/* SPATIAL GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.spatial}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <MasteringControl 
                label={t.haas} 
                value={settings.haasAmount} 
                min={-100} max={100} step={0.01} 
                onChange={(v) => updateSetting('haasAmount', v)} 
                tooltip={t.haasTip}
                unit="ms"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.stereo}
                value={settings.stereoWidth}
                min={-50} max={50} step={0.01}
                onChange={(v) => updateSetting('stereoWidth', v)}
                tooltip={t.stereoTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.widener}
                value={settings.widenerAmt}
                min={0} max={100} step={0.1}
                onChange={(v) => updateSetting('widenerAmt', v)}
                tooltip={t.widenerTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
              <button
                onClick={() => updateSetting('mono', settings.mono ? 0 : 1)}
                disabled={monitoringMode !== 'master'}
                title={t.monoTip}
                className={cn(
                  "w-full text-[9px] px-3 py-1.5 border uppercase font-bold tracking-[0.2em] rounded-sm disabled:opacity-30 transition-all",
                  settings.mono
                    ? "bg-[var(--accent)] border-[var(--accent)] text-black"
                    : "bg-black border-[#444] hover:border-[var(--accent)] hover:text-[#fff] text-[var(--text-dim)]"
                )}
              >
                {t.mono}
              </button>
            </div>

            {/* MOD FX GROUP */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <div className="h-[1px] flex-1 bg-white/5" />
                <span className="text-[8px] font-bold uppercase tracking-[0.2em] text-[#444]">{t.modfx}</span>
                <div className="h-[1px] flex-1 bg-white/5" />
              </div>
              <MasteringControl
                label={t.phaser}
                value={settings.phaserAmt}
                min={0} max={100} step={0.1}
                onChange={(v) => updateSetting('phaserAmt', v)}
                tooltip={t.phaserTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.flanger}
                value={settings.flangerAmt}
                min={0} max={100} step={0.1}
                onChange={(v) => updateSetting('flangerAmt', v)}
                tooltip={t.flangerTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
              <MasteringControl
                label={t.tremolo}
                value={settings.tremoloAmt}
                min={0} max={100} step={0.1}
                onChange={(v) => updateSetting('tremoloAmt', v)}
                tooltip={t.tremoloTip}
                unit="LVL"
                disabled={monitoringMode !== 'master'}
              />
            </div>
          </div>
        </aside>

        {/* Center: Visualizer Area */}
        <section className="bg-[#090a0c] flex flex-col p-6 overflow-y-auto w-full relative">
          <div className="flex justify-between items-start mb-6">
            <div className="flex items-center gap-4">
              <button 
                onClick={togglePlayback}
                disabled={!track}
                className="w-12 h-12 shrink-0 bg-[var(--accent)] text-black rounded-full flex items-center justify-center hover:scale-105 active:scale-95 disabled:opacity-20 transition-all shadow-lg shadow-[var(--accent)]/10"
              >
                {isPlaying ? <Square size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-1" />}
              </button>
              <div className="flex flex-col gap-2">
                <div className="flex bg-black border border-[var(--border)] p-0.5 rounded-sm self-start">
                  <button 
                    onClick={() => setMonitoring('master')}
                    className={cn(
                      "px-3 py-1 text-[10px] uppercase font-bold tracking-widest transition-colors",
                      monitoringMode === 'master' ? "bg-[var(--accent)] text-black" : "text-[var(--text-dim)] hover:text-white"
                    )}
                  >
                    {t.master}
                  </button>
                  <button 
                    onClick={() => setMonitoring('source')}
                    className={cn(
                      "px-3 py-1 text-[10px] uppercase font-bold tracking-widest transition-colors",
                      monitoringMode === 'source' ? "bg-white/20 text-white border-l border-white/10" : "text-[var(--text-dim)] hover:text-white border-l border-white/5"
                    )}
                  >
                    {t.source}
                  </button>
                  <button 
                    onClick={() => {
                      if (refTrack) setMonitoring('reference');
                    }}
                    disabled={!refTrack}
                    className={cn(
                      "px-3 py-1 text-[10px] uppercase font-bold tracking-widest transition-colors disabled:opacity-20 border-l border-white/5",
                      monitoringMode === 'reference' ? "bg-[var(--accent)] text-black" : "text-[var(--text-dim)] hover:text-white"
                    )}
                  >
                    {t.ref}
                  </button>
                </div>
                <div>
                  <h2 className="text-xl font-bold tracking-tight text-white leading-none whitespace-nowrap overflow-hidden text-ellipsis max-w-[400px]" title={monitoringMode === 'reference' ? (refTrack?.name || t.ref) : (track ? metadata.title : t.waitAudio)}>
                    {monitoringMode === 'reference' ? (refTrack?.name || t.ref) : (track ? metadata.title : t.waitAudio)}
                  </h2>
                  <div className="flex items-center gap-3 mt-2">
                    <div className="flex bg-black border border-[var(--border)] p-0.5 rounded-sm flex-wrap">
                      {(['bars', 'circle', 'wave', 'alchemy', 'circles', 'flight', 'smoke'] as const).map(m => (
                        <button 
                          key={m}
                          onClick={() => setVisMode(m)}
                          className={cn(
                            "px-2 py-0.5 text-[9px] uppercase font-bold tracking-widest transition-colors",
                            visMode === m ? "bg-[var(--accent)] text-black" : "text-[var(--text-dim)] hover:text-white"
                          )}
                        >
                          {(t as any)[`vis${m.charAt(0).toUpperCase() + m.slice(1)}`] || m.charAt(0).toUpperCase() + m.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right side buttons (Upload & Reference) */}
            <div className="flex flex-col gap-1.5 shrink-0 ml-4 border-l border-[#222] pl-4">
              <input 
                id="track-upload"
                type="file" 
                accept="audio/*" 
                onChange={handleFileUpload}
                className="hidden"
              />
              <button 
                onClick={() => document.getElementById('track-upload')?.click()}
                className="flex items-center justify-between gap-3 px-3 py-1.5 bg-[#0a0a0c] border border-[var(--border)] text-white text-[9px] font-bold uppercase tracking-widest rounded-sm hover:bg-[#1a1c22] w-[180px] transition-colors"
                title={track ? metadata.title : ''}
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <Upload size={12} className="text-[var(--accent)] shrink-0" />
                  <span className="truncate whitespace-nowrap">{track ? metadata.title : t.upload}</span>
                </div>
              </button>

              <input 
                id="ref-upload"
                type="file" 
                accept="audio/*" 
                onChange={handleRefUpload}
                className="hidden"
              />
              <button 
                onClick={() => document.getElementById('ref-upload')?.click()}
                className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[#0a0a0c] border border-[var(--border)] text-white text-[9px] font-bold uppercase tracking-widest rounded-sm hover:bg-[#1a1c22] w-[180px] transition-colors"
                title={refTrack ? refTrack.name : ''}
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <Music size={12} className="text-[var(--accent)] shrink-0" />
                  <span className="truncate whitespace-nowrap">{refTrack ? refTrack.name : ((t as any).loadRef || "Load Reference")}</span>
                </div>
              </button>
            </div>
          </div>

          <AnimatePresence>
            {showLogs && (
              <div className="absolute inset-0 z-[100] p-12 bg-black/90 backdrop-blur-md flex items-center justify-center pointer-events-auto">
                <div className="w-full max-w-5xl h-[80vh] relative flex flex-col">
                  <button 
                    onClick={() => setShowLogs(false)}
                    className="absolute -top-12 -right-4 text-white/60 hover:text-[var(--accent)] font-bold text-[10px] uppercase tracking-[3px] transition-all flex items-center gap-2"
                  >
                    {t.closeAnalysis} <Square size={10} className="rotate-45" />
                  </button>
                  <div className="flex-1 min-h-0 bg-[#0a0a0c] border border-[var(--border)] rounded-md shadow-2xl overflow-hidden">
                    <DiagnosticPanel
                      logs={analysisLogs}
                      lang={lang}
                      onAiAnalyze={handleAiReport}
                      aiAnalyzing={aiReportBusy}
                      aiReport={aiReport}
                      aiReportError={aiReportError}
                      trackMetrics={trackMetrics}
                      trackMetricsBusy={trackMetricsBusy}
                    />
                  </div>
                </div>
              </div>
            )}
          </AnimatePresence>
          
          <div className="flex-[2] min-h-[250px] bg-[#0c0d11] border border-[#1a1c22] rounded-md overflow-hidden relative mb-2">
            <AudioVisualizer mode={visMode} analyser={audioEngine.current?.getAnalysers().L || null} coverArt={coverArt || "./logo_Neural Master Pro.png"} coverOffset={coverOffset} />
          </div>

          <div className={cn("flex gap-4 mb-2 shrink-0", appMode === 'pro' ? "items-stretch h-[200px]" : "items-start")}>
            <div className={cn("flex gap-2 bg-[#0c0d11] border border-[#1a1c22] px-4 py-3 rounded-md shrink-0 justify-center items-center", appMode === 'pro' && "self-stretch")}>
              <div className="flex flex-col items-center h-full justify-between">
                <div className="text-[9px] font-mono text-[var(--accent)]">{Math.round(monitorVolume * 100)}%</div>
                <div className="flex-1 w-[20px] flex items-center justify-center my-6 relative min-h-[100px]">
                  <div className="absolute left-1/2 -translate-x-1/2 w-[2px] h-full bg-[#1a1c22]" />
                  <div className="absolute flex flex-col justify-between h-full -left-3 text-[7px] text-[var(--text-dim)] font-mono opacity-50 pointer-events-none pb-2">
                    <span>100</span><span>50</span><span>0</span>
                  </div>
                  <input 
                    type="range" min="0" max="1" step="0.01" 
                    value={monitorVolume}
                    onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                    className="w-[100px] h-1 bg-transparent appearance-none cursor-pointer accent-[var(--accent)] transform -rotate-90 origin-center absolute z-10"
                  />
                </div>
                <div className="text-[9px] font-mono text-[var(--text-dim)] uppercase tracking-widest">{t.volume}</div>
              </div>
              
              <div className="w-[1px] h-full bg-white/5 mx-2" />

              <div className="flex flex-col items-center h-full justify-between">
                <div className="text-[9px] font-mono text-[var(--accent)]">{getSpeed(playbackSpeed).toFixed(2)}x</div>
                <div className="flex-1 w-[20px] flex items-center justify-center my-6 relative min-h-[100px]">
                  <div className="absolute left-1/2 -translate-x-1/2 w-[2px] h-full bg-[#1a1c22]" />
                  <div className="absolute flex flex-col justify-between h-full -right-5 text-[7px] text-[var(--text-dim)] font-mono opacity-50 pointer-events-none text-right pb-2">
                    <span>3.0</span><span>1.0</span><span>0.3</span>
                  </div>
                  <input 
                    type="range" min="-3" max="3" step="0.05" 
                    value={playbackSpeed}
                    onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
                    className="w-[100px] h-1 bg-transparent appearance-none cursor-pointer accent-[var(--accent)] transform -rotate-90 origin-center absolute z-10"
                  />
                </div>
                <div className="text-[9px] font-mono text-[var(--text-dim)] uppercase tracking-widest">{(t as any).speed || "Speed"}</div>
              </div>
            </div>
            {appMode === 'pro' ? (
              <div className="flex-1 min-w-0 [&>div]:mb-0 h-full flex flex-col">
                <GraphicEQ
                  settings={settings}
                  onChange={updateSetting}
                  onBatchChange={updateMultipleSettings}
                  disabled={monitoringMode !== 'master'}
                  lang={lang}
                />
              </div>
            ) : (
              <div className="flex-1 min-w-0">
                <LiteMaster
                  lang={lang}
                  engine={audioEngine.current}
                  trackLoaded={!!track}
                  refTrackLoaded={!!refTrack}
                  metadata={metadata}
                  isPlaying={isPlaying}
                  onPlaybackChange={setIsPlaying}
                  onNotify={showToast}
                />
              </div>
            )}
          </div>

          {appMode === 'pro' && (<>
          {/* Stem Selector for FX + solo preview + stems export */}
          <div className="mb-2 flex items-center justify-center gap-1 border border-[#222] bg-[#0c0d11] p-1 rounded-sm">
            {[
              { id: 'master', label: (t as any).stemMaster || 'MASTER' },
              { id: 'bass', label: (t as any).stemBass || 'BASS' },
              { id: 'vocal', label: (t as any).stemVocal || 'VOCAL' },
              { id: 'mid', label: (t as any).stemMid || 'MID' },
              { id: 'side', label: (t as any).stemSide || 'SIDE' },
            ].map(stem => (
              <button
                key={stem.id}
                onClick={() => {
                  setActiveStem(stem.id as TargetStem);
                  // Solo follows the selected stem (master tab exits solo).
                  const soloIdx = ({ bass: 1, vocal: 2, mid: 3, side: 4 } as Record<string, number>)[stem.id] ?? 0;
                  if (settings.stem_solo > 0) updateSetting('stem_solo' as keyof MasteringSettings, soloIdx);
                }}
                className={`flex-1 text-[9px] font-bold py-1.5 rounded-sm transition-all ${activeStem === stem.id ? 'bg-[var(--accent)] text-black' : 'text-[var(--text-dim)] hover:bg-[#1a1c22] hover:text-white'}`}
              >
                {stem.label}
              </button>
            ))}
            {(() => {
              const soloIdx = ({ bass: 1, vocal: 2, mid: 3, side: 4 } as Record<string, number>)[activeStem] ?? 0;
              const soloOn = settings.stem_solo > 0;
              return (
                <button
                  data-testid="stem-solo"
                  disabled={soloIdx === 0}
                  onClick={() => updateSetting('stem_solo' as keyof MasteringSettings, soloOn ? 0 : soloIdx)}
                  title={(t as any).stemSolo || 'Solo'}
                  className={`px-2 text-[9px] font-bold py-1.5 rounded-sm transition-all border ${soloIdx === 0 ? 'opacity-30 border-[#222] text-[var(--text-dim)]' : soloOn ? 'bg-[#ff3366] text-black border-[#ff3366]' : 'border-[var(--border)] text-[var(--text-dim)] hover:text-white'}`}
                >
                  {(t as any).stemSolo || 'SOLO'}
                </button>
              );
            })()}
            <button
              data-testid="export-stems"
              disabled={stemsExportBusy || monitoringMode !== 'master'}
              onClick={handleExportStems}
              title={(t as any).exportStems || 'Export Stems'}
              className="px-2 text-[9px] font-bold py-1.5 rounded-sm transition-all border border-[var(--border)] text-[var(--text-dim)] hover:text-white disabled:opacity-30"
            >
              {stemsExportBusy ? '…' : ((t as any).exportStems || 'STEMS ⬇')}
            </button>
          </div>

          {/* FX Settings row */}
          <div className="mb-2 grid grid-cols-5 gap-2 border-t border-b border-[#222] py-2">
            {[
              { id: 'autotune', label: (t as any).autotune || 'Autotune' },
              { id: 'reverb', label: (t as any).reverb || 'Reverb' },
              { id: 'distortion', label: (t as any).distortion || 'Distortion' },
              { id: 'delay', label: (t as any).delay || 'Delay' },
              { id: 'chorus', label: (t as any).chorus || 'Chorus' },
            ].map(fx => {
              const fullFxId = activeStem === 'master' ? fx.id : `${activeStem}_${fx.id}`;
              const currentVal = activeFXRegionId 
                ? (effectRegions.find(r => r.id === activeFXRegionId)?.effects[fx.id as keyof EffectRegion['effects']] ?? settings[fullFxId as keyof MasteringSettings])
                : settings[fullFxId as keyof MasteringSettings];
              
              const isActiveLocal = !!activeFXRegionId;
              const activeColor = activeFXRegionId ? (effectRegions.find(r => r.id === activeFXRegionId)?.color || 'var(--accent)') : '';

              return (
              <div key={fx.id} className={`flex flex-col gap-1 items-center p-2 border rounded-sm transition-colors ${isActiveLocal ? 'bg-[#002222] border-white/20' : 'bg-[#090a0c] border-[var(--border)]'}`} style={{ borderColor: isActiveLocal ? activeColor : undefined }}>
                <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isActiveLocal ? activeColor : 'var(--accent)' }}>{fx.label}</div>
                <input 
                  type="range"
                  min="0" max="100" step="1"
                  disabled={monitoringMode !== 'master'}
                  value={currentVal as number}
                  onChange={(e) => {
                     const val = parseFloat(e.target.value);
                     if (activeFXRegionId) {
                        setEffectRegions(prev => prev.map(r => r.id === activeFXRegionId ? { ...r, effects: { ...r.effects, [fx.id]: val } } : r));
                     } else {
                        updateSetting(fullFxId as keyof MasteringSettings, val);
                     }
                  }}
                  className="w-full h-1 mt-2 bg-[#222] rounded-lg appearance-none cursor-pointer disabled:opacity-30"
                  style={{ accentColor: isActiveLocal ? activeColor : 'var(--accent)' }}
                />
                <div className="text-[9px] font-mono mt-1" style={{ color: isActiveLocal ? '#fff' : 'var(--text-dim)' }}>{Math.round(currentVal as number)}%</div>
              </div>
            )})}
          </div>

          <div className="flex flex-col gap-2 mb-2">
            <div className="flex justify-between items-center px-1">
              <span className="text-[10px] font-bold text-[var(--text-dim)] uppercase tracking-widest">
                {activeFXRegionId ? ((t as any).fxRegionsEditing || "FX Automation Regions (Editing Area)") : ((t as any).fxRegions || "FX Automation Regions")}
              </span>
              <button 
                onClick={handleAddFXRegion}
                disabled={monitoringMode !== 'master' || duration <= 0}
                className="text-[9px] font-bold text-black bg-[var(--accent)] hover:bg-[#00cccc] px-2 py-1 rounded-sm uppercase tracking-wider disabled:opacity-30 disabled:grayscale transition-all"
                title="Add a new FX region to the track"
              >
                {(t as any).addFxRegion || "+ ADD FX REGION"}
              </button>
            </div>
            {effectRegions.length > 0 && (
              <div className="flex flex-col gap-1 w-full bg-[#0a0a0c] p-2 rounded-sm border border-[#222] overflow-y-auto max-h-[160px]">
                {effectRegions.map(reg => {
                  const isActive = activeFXRegionId === reg.id;
                  return (
                    <div key={reg.id} className="relative w-full h-[32px] shrink-0 bg-[#0c0d11] rounded-sm group overflow-hidden">
                      {/* Timeline Background Visual */}
                      <div 
                        className={`absolute h-full rounded-sm transition-colors ${isActive ? 'bg-[var(--panel)] border border-white' : 'bg-[#1a1c22] border border-[#333]'}`}
                        style={{
                          left: `${(reg.start / Math.max(0.1, duration)) * 100}%`,
                          width: `${((reg.end - reg.start) / Math.max(0.1, duration)) * 100}%`,
                          backgroundColor: `${reg.color}${isActive ? '40' : '20'}`
                        }}
                      >
                        {/* Brackets and Text Inputs inside the graphical block */}
                        <div className="absolute inset-0 flex items-center justify-center font-mono text-[10px] z-20 pointer-events-none">
                          <div className="flex items-center bg-black/80 px-2 rounded-sm text-white shadow-lg pointer-events-auto" style={{ borderColor: reg.color, borderWidth: 1 }}>
                            <select 
                              value={reg.targetStem} 
                              onChange={(e) => setEffectRegions(prev => prev.map(r => r.id === reg.id ? { ...r, targetStem: e.target.value as TargetStem } : r))}
                              className="bg-transparent text-[9px] text-[var(--accent)] outline-none mr-2 uppercase text-center font-bold"
                              style={{ color: reg.color }}
                            >
                              <option className="bg-black" value="master">{(t as any).stemMaster || 'MASTER'}</option>
                              <option className="bg-black" value="bass">{(t as any).stemBass || 'BASS'}</option>
                              <option className="bg-black" value="vocal">{(t as any).stemVocal || 'VOCAL'}</option>
                              <option className="bg-black" value="mid">{(t as any).stemMid || 'MID'}</option>
                              <option className="bg-black" value="side">{(t as any).stemSide || 'SIDE'}</option>
                            </select>
                            <span className="text-[var(--text-dim)] font-bold mr-1">[</span>
                            <input 
                              type="number" step="0.01" 
                              value={Number(reg.start).toFixed(2)} 
                              onChange={e => updateRegionStart(reg.id, e.target.value)}
                              className="w-[45px] bg-transparent text-center appearance-none outline-none"
                            />
                            <div 
                              className="mx-2 px-2 cursor-pointer font-extrabold transition-all hover:scale-125"
                              style={{ color: isActive ? '#fff' : reg.color, textShadow: isActive ? `0 0 8px ${reg.color}` : 'none' }}
                              onClick={() => setActiveFXRegionId(isActive ? null : reg.id)}
                            >
                              -
                            </div>
                            <input 
                              type="number" step="0.01" 
                              value={Number(reg.end).toFixed(2)} 
                              onChange={e => updateRegionEnd(reg.id, e.target.value)}
                              className="w-[45px] bg-transparent text-center appearance-none outline-none"
                            />
                            <span className="text-[var(--text-dim)] font-bold ml-1">]</span>
                            
                            <button onClick={() => handleRemoveFXRegion(reg.id)} className="ml-3 relative z-50 pointer-events-auto text-red-500/60 hover:text-red-500 transition-colors">
                              <X size={10} />
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* INVISIBLE RANGE SLIDERS FOR EDGE DRAGGING */}
                      <input 
                        type="range" min={0} max={duration} step={0.01} value={reg.start}
                        onChange={(e) => updateRegionStart(reg.id, e.target.value)}
                        className="absolute w-full h-full appearance-none bg-transparent pointer-events-none z-10 [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-[16px] [&::-webkit-slider-thumb]:h-[32px] [&::-webkit-slider-thumb]:cursor-col-resize opacity-0"
                      />
                      <input 
                        type="range" min={0} max={duration} step={0.01} value={reg.end}
                        onChange={(e) => updateRegionEnd(reg.id, e.target.value)}
                        className="absolute w-full h-full appearance-none bg-transparent pointer-events-none z-10 [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-[16px] [&::-webkit-slider-thumb]:h-[32px] [&::-webkit-slider-thumb]:cursor-col-resize opacity-0"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <VocalAlignPanel t={t} bitDepth={proWavBit} showToast={showToast} />
          </>)}

          {/* Seek Bar (own 10 Hz time state — keeps App off the hot path) */}
          <TimeControls engineRef={audioEngine} duration={duration} hasTrack={!!track} onSeek={handleSeek} />

          {/* Metering Bridge */}
          <MeteringBridge isPlaying={isPlaying} analysers={audioEngine.current?.getAnalysers() || null} lang={lang} />
        </section>

        {/* Right: Info & Export */}
        <aside className="bg-[var(--panel)] p-5 overflow-y-auto flex flex-col gap-6">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--text-dim)] mb-3">{t.metadata}</div>
            <div
              onClick={() => {
                // A finished drag also ends in a click on the box — suppress
                // it or the upload dialog would open right after panning.
                if (coverDragMovedRef.current) { coverDragMovedRef.current = false; return; }
                document.getElementById('cover-upload')?.click();
              }}
              className="aspect-square bg-black border-2 border-dashed border-[var(--border)] flex flex-col items-center justify-center text-[11px] text-[var(--text-dim)] rounded-lg hover:border-[var(--accent)]/40 transition-colors cursor-pointer group overflow-hidden relative"
            >
              {coverArt ? (
                <img
                  src={coverArt}
                  alt="Cover Art"
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                  style={coverTransform ? { transform: coverTransform, cursor: 'grab', touchAction: 'none' } : undefined}
                  onPointerDown={onCoverPointerDown}
                  onPointerMove={onCoverPointerMove}
                  onPointerUp={onCoverPointerUp}
                  onPointerCancel={onCoverPointerUp}
                />
              ) : (
                <>
                  <ImageIcon size={32} className="mb-2 opacity-20 group-hover:opacity-50" />
                  {t.dropArt}
                </>
              )}
              <input
                id="cover-upload"
                type="file"
                accept="image/*"
                onChange={handleCoverUpload}
                className="hidden"
              />
            </div>
            {coverDragPossible && (
              <div className="text-[9px] text-[var(--text-dim)] mt-1">{(t as any).coverDragHint}</div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{t.titleLabel}</label>
              <input 
                type="text" 
                value={metadata.title}
                onChange={(e) => setMetadata({...metadata, title: e.target.value})}
                className="w-full bg-black border border-[var(--border)] rounded-sm px-3 py-2 text-[13px] focus:border-[var(--accent)] outline-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
               <div>
                <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{t.bpm}</label>
                <input 
                  type="number" 
                  value={metadata.bpm || ''}
                  onChange={(e) => setMetadata({...metadata, bpm: parseInt(e.target.value)})}
                  className="w-full bg-black border border-[var(--border)] rounded-sm px-3 py-2 text-[13px] focus:border-[var(--accent)] outline-none"
                />
              </div>
              <div>
                <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{t.key}</label>
                <input 
                  type="text" 
                  placeholder="Am, C#, etc"
                  value={metadata.key || ''}
                  onChange={(e) => setMetadata({...metadata, key: e.target.value})}
                  className="w-full bg-black border border-[var(--border)] rounded-sm px-3 py-2 text-[13px] focus:border-[var(--accent)] outline-none"
                />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--text-dim)]">{(t as any).trim || "Trim"}</div>
            <div className="bg-black border border-[var(--border)] rounded-sm p-3 flex flex-col gap-3">
              <div className="flex gap-2">
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-[9px] text-[var(--text-dim)] uppercase">{(t as any).start || "Start (s)"}</label>
                  <input type="number" step="0.01" value={trimStart} onChange={e => setTrimStart(e.target.value)} className="w-full bg-[#0c0d11] border border-[var(--border)] rounded-sm px-2 py-1.5 text-[11px] text-[var(--accent)] font-mono outline-none" />
                </div>
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-[9px] text-[var(--text-dim)] uppercase">{(t as any).length || "Length (s)"}</label>
                  <input type="number" step="0.01" value={(Number(trimEnd) - Number(trimStart)).toFixed(2)} onChange={e => setTrimEnd((Number(trimStart) + (parseFloat(e.target.value)||0)).toFixed(2))} className="w-full bg-[#0c0d11] border border-[var(--border)] rounded-sm px-2 py-1.5 text-[11px] text-[var(--accent)] font-mono outline-none" />
                </div>
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-[9px] text-[var(--text-dim)] uppercase">{(t as any).end || "End (s)"}</label>
                  <input type="number" step="0.01" value={trimEnd} onChange={e => setTrimEnd(e.target.value)} className="w-full bg-[#0c0d11] border border-[var(--border)] rounded-sm px-2 py-1.5 text-[11px] text-[var(--accent)] font-mono outline-none" />
                </div>
              </div>

              <div className="flex gap-2 mt-2">
                <select value={Number(trimStart)} onChange={e => setTrimStart(parseFloat(e.target.value)||0)} className="flex-1 bg-[#1a1c22] text-[10px] text-white p-1.5 rounded-sm outline-none cursor-pointer">
                  <option value={0}>0:00 (Start)</option>
                  <option value={10}>0:10</option>
                  <option value={30}>0:30</option>
                  <option value={60}>1:00</option>
                </select>
                <select value={Number(trimEnd)} onChange={e => setTrimEnd(parseFloat(e.target.value)||0)} className="flex-1 bg-[#1a1c22] text-[10px] text-white p-1.5 rounded-sm outline-none cursor-pointer">
                  <option value={duration}>{(t as any).original || "Original"}</option>
                  <option value={duration + 5}>+5s {(t as any).tail || "Tail"}</option>
                  <option value={duration + 10}>+10s {(t as any).tail || "Tail"}</option>
                </select>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--text-dim)]">{t.exportMusic}</div>
            
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={exportAudio} onChange={(e) => setExportAudio(e.target.checked)} className="accent-[var(--accent)]" />
                <span className="text-[11px] font-bold text-white">{t.exportMusic}</span>
              </label>

              {exportAudio && (
                <div className="grid grid-cols-2 gap-2 border-l-2 border-[#333] pl-3 ml-1">
                  <div>
                    <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{t.format}</label>
                    <select
                      value={exportFormat}
                      onChange={(e) => {
                        const v = e.target.value as ExportFormat;
                        setExportFormat(v);
                        // Warm the local ffmpeg core once (30 MB, public/ffmpeg/).
                        if (v === 'aac' && (aacState === 'idle' || aacState === 'error')) {
                          setAacState('loading');
                          import('./lib/aacEncoder').then(({ preloadAac }) => preloadAac()).then(
                            () => setAacState('ready'),
                            (err) => { console.error(err); setAacState('error'); }
                          );
                        }
                      }}
                      className="w-full bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none"
                    >
                      <option value="wav">WAV (Pro)</option>
                      <option value="flac">FLAC</option>
                      <option value="mp3">MP3</option>
                      <option value="aac">AAC</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{t.quality}</label>
                    {exportFormat === 'aac' ? (
                      <select
                        value={aacKbps}
                        onChange={(e) => setAacKbps(Number(e.target.value) as 128 | 256)}
                        className="w-full bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none"
                      >
                        <option value={256}>AAC · 256 kbps</option>
                        <option value={128}>AAC · 128 kbps</option>
                      </select>
                    ) : (
                      <select
                        value={proWavBit}
                        onChange={(e) => setProWavBit(Number(e.target.value) as 16 | 24 | 32)}
                        disabled={exportFormat !== 'wav'}
                        title={exportFormat === 'wav' ? undefined : `${t.format}: MP3 = 320 kbps, FLAC = 24-bit`}
                        className="w-full bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none disabled:opacity-40"
                      >
                        <option value={32}>{t.float32}</option>
                        <option value={24}>{t.bit24}</option>
                        <option value={16}>{t.bit16}</option>
                      </select>
                    )}
                  </div>
                </div>
              )}

              {exportAudio && exportFormat === 'aac' && (aacState === 'loading' || aacState === 'error') && (
                <div className={`text-[10px] mt-2 ${aacState === 'error' ? 'text-red-400' : 'text-[var(--text-dim)]'}`}>
                  {aacState === 'error' ? t.aacError : t.aacLoading}
                </div>
              )}

              <label className="flex items-center gap-2 cursor-pointer mt-2">
                <input type="checkbox" checked={exportVideo} onChange={(e) => setExportVideo(e.target.checked)} className="accent-[var(--accent)]" />
                <span className="text-[11px] font-bold text-white">{t.exportVideo || "Export Video"}</span>
              </label>

              {exportVideo && (
                <div className="space-y-3 border-l-2 border-[#333] pl-3 ml-1">
                  <div>
                    <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{(t as any).orientation || "Orientation"}</label>
                    <select
                      value={videoOrientation}
                      onChange={(e) => { setVideoOrientation(e.target.value as any); resetPexelsSelection(); }}
                      className="w-full bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none"
                    >
                      <option value="vertical">{(t as any).vertical || "Vertical (9:16)"}</option>
                      <option value="horizontal">{(t as any).horizontal || "Horizontal (16:9)"}</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{t.resolution || "Resolution"}</label>
                      <select 
                        value={videoRes}
                        onChange={(e) => setVideoRes(e.target.value as any)}
                        className="w-full bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none"
                      >
                        <option value="fhd">Full HD (1080x1920)</option>
                        <option value="2k">2K (1440x2560)</option>
                        <option value="4k">4K (2160x3840)</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{t.fps || "FPS"}</label>
                      <select 
                        value={videoFps}
                        onChange={(e) => setVideoFps(parseInt(e.target.value) as any)}
                        className="w-full bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none"
                      >
                        <option value="30">30 FPS</option>
                        <option value="60">60 FPS</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{t.bitrate || "Bitrate"}</label>
                    <select 
                      value={videoBitrate}
                      onChange={(e) => setVideoBitrate(e.target.value as any)}
                      className="w-full bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none"
                    >
                      <option value="low">{t.bitrateLow || "Low"} (~{(videoFps === 60 ? 10 : 5) * (videoRes === '2k' ? 2 : videoRes === '4k' ? 4 : 1)} Mbps)</option>
                      <option value="medium">{t.bitrateMed || "Medium"} (~{(videoFps === 60 ? 20 : 10) * (videoRes === '2k' ? 2 : videoRes === '4k' ? 4 : 1)} Mbps)</option>
                      <option value="high">{t.bitrateHigh || "High"} (~{(videoFps === 60 ? 30 : 15) * (videoRes === '2k' ? 2 : videoRes === '4k' ? 4 : 1)} Mbps)</option>
                    </select>
                  </div>
                  <div className="pt-2 border-t border-[var(--border)]">
                    <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{(t as any).videoBgMode || "Video Background"}</label>
                    <div className="flex gap-1.5">
                      <label className={`flex-1 bg-black border rounded-sm px-2 py-2 text-[11px] cursor-pointer ${videoBgMode === 'visualizer' ? "border-[var(--accent)]" : "border-[var(--border)]"}`}>
                        <input type="radio" name="videoBgMode" className="accent-[var(--accent)] mr-1.5" checked={videoBgMode === 'visualizer'} onChange={() => setVideoBgMode('visualizer')} />
                        {t.visMode || "Visualizer"}
                      </label>
                      <label className={`flex-1 bg-black border rounded-sm px-2 py-2 text-[11px] cursor-pointer ${videoBgMode === 'pexels' ? "border-[var(--accent)]" : "border-[var(--border)]"}`}>
                        <input type="radio" name="videoBgMode" className="accent-[var(--accent)] mr-1.5" checked={videoBgMode === 'pexels'} onChange={() => setVideoBgMode('pexels')} />
                        {(t as any).pexelsBg || "Pexels"}
                      </label>
                    </div>
                    {videoBgMode === 'pexels' && (
                      <div className="mt-2 space-y-2">
                        <div>
                          <input
                            type="password"
                            autoComplete="off"
                            value={pexelsKeyInput}
                            onChange={(e) => {
                              setPexelsKeyInput(e.target.value);
                              setPexelsKey(e.target.value);
                              setPexelsHasKey(hasPexelsKey());
                            }}
                            placeholder={(t as any).pexelsKeyPlaceholder || "Pexels API key (free at pexels.com/api)"}
                            className="w-full bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none"
                          />
                          <p className="mt-1 text-[9px] font-mono text-[var(--text-dim)]">
                            {pexelsHasKey
                              ? ((t as any).pexelsKeyHint || 'Stored only on this device')
                              : ((t as any).pexelsNoKey || 'Add your Pexels API key to search — get one free at pexels.com/api')}
                          </p>
                        </div>
                        <div className="flex gap-1.5">
                          <input
                            type="text"
                            value={pexelsQuery}
                            onChange={(e) => setPexelsQuery(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') runPexelsSearch(); }}
                            placeholder={(t as any).searchPexels || "Search Pexels videos…"}
                            className="flex-1 min-w-0 bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none"
                          />
                          <button
                            onClick={runPexelsSearch}
                            disabled={pexelsSearching || !pexelsQuery.trim()}
                            className="px-3 text-[11px] bg-[var(--accent)] text-black rounded-sm disabled:opacity-40"
                          >
                            {pexelsSearching ? ((t as any).searchingVideos || "Searching…") : ((t as any).find || "Find")}
                          </button>
                        </div>
                        {pexelsError && <p className="text-[10px] text-red-400 font-mono">{pexelsError}</p>}
                        {pexelsResults.length > 0 && (
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[9px] font-mono text-[var(--text-dim)]">
                                {((t as any).selectUpTo || 'Select up to {n} clips — they cut on the audio peaks').replace('{n}', String(MAX_PEXELS_CLIPS))}
                              </p>
                              {pexelsSelection.length > 0 && (
                                <button onClick={clearPexelsSelection} className="shrink-0 text-[9px] font-mono text-[var(--text-dim)] hover:text-white underline">
                                  {(t as any).clearSelection || 'Clear'}
                                </button>
                              )}
                            </div>
                            <div className="grid grid-cols-3 gap-1.5 max-h-[220px] overflow-y-auto pr-1 mt-1">
                              {pexelsResults.map(clip => {
                                const selIdx = pexelsSelection.findIndex((s) => s.clip.id === clip.id);
                                return (
                                  <button
                                    key={clip.id}
                                    onClick={() => handleClipToggle(clip)}
                                    className={`relative rounded-sm overflow-hidden border ${selIdx >= 0 ? "border-[var(--accent)] shadow-[0_0_8px_rgba(255,0,128,0.4)]" : "border-[var(--border)]"}`}
                                  >
                                    <img src={clip.image} alt="" className="w-full aspect-[9/16] object-cover" loading="lazy" referrerPolicy="no-referrer" />
                                    {selIdx >= 0 && (
                                      <span className="absolute top-0 left-0 bg-[var(--accent)] text-black text-[9px] font-bold px-1">{selIdx + 1}</span>
                                    )}
                                    <span className="absolute bottom-0 inset-x-0 bg-black/70 text-[8px] font-mono text-white px-1 py-0.5 flex items-center justify-between">
                                      <span>{Math.round(clip.duration)}s</span>
                                      <span className="truncate ml-1 max-w-[70%]">{clip.user.name}</span>
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        {pexelsSelection.length > 0 && (
                          <div className="space-y-1.5">
                            <p className="text-[9px] font-mono text-[var(--text-dim)]">
                              {((t as any).clipsSelected || '{n}/{max} selected').replace('{n}', String(pexelsSelection.length)).replace('{max}', String(MAX_PEXELS_CLIPS))}
                              {' · '}
                              {((t as any).clipsReady || '{done}/{total} clips ready').replace('{done}', String(pexelsReadyItems.length)).replace('{total}', String(pexelsSelection.length))}
                            </p>
                            {pexelsSelection.some((s) => s.status === 'downloading') && (
                              <div>
                                <div className="h-1 bg-[#1a1c22] rounded-sm overflow-hidden">
                                  <div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${Math.round(pexelsSelection.reduce((a, s) => a + s.progress, 0) / pexelsSelection.length * 100)}%` }} />
                                </div>
                                <p className="text-[10px] font-mono text-[var(--text-dim)] mt-1">{(t as any).downloading || "Downloading…"}</p>
                              </div>
                            )}
                            {pexelsSelection.filter((s) => s.status === 'error').map((s) => (
                              <button key={s.clip.id} onClick={() => handleClipRetry(s.clip)} className="w-full bg-black border border-red-500/50 text-red-400 rounded-sm px-2 py-2 text-[11px]">
                                #{pexelsSelection.findIndex((x) => x.clip.id === s.clip.id) + 1} {(t as any).retryDownload || "Retry download"}
                              </button>
                            ))}
                            {pexelsReadyItems.length > 0 && (
                              <label className="flex items-start gap-1.5 text-[10px] font-mono cursor-pointer text-[var(--text-dim)]">
                                <input type="checkbox" checked={showCredit} onChange={(e) => setShowCredit(e.target.checked)} className="accent-[var(--accent)] mt-px" />
                                <span>{((t as any).videoCredit || 'Show "Video: Pexels / {author}" credit in clip').replace('{author}', pexelsCreditNames.join(', '))}</span>
                              </label>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {/* Karaoke subtitles — offline Whisper ASR (v2.6). Works with
                        either background mode; burn-in + .srt share one region clock. */}
                    <div className="pt-2 border-t border-[var(--border)]">
                      <label className="flex items-center gap-1.5 text-[11px] font-bold text-white cursor-pointer">
                        <input type="checkbox" checked={karaokeOn} onChange={(e) => setKaraokeOn(e.target.checked)} className="accent-[var(--accent)]" />
                        {(t as any).karaokeOn || 'Karaoke subtitles'}
                      </label>
                      {karaokeOn && (
                        <div className="mt-2 space-y-2">
                          <button
                            onClick={handleRecognizeLyrics}
                            disabled={asrState === 'running' || !track}
                            className="w-full bg-[var(--accent)] text-black rounded-sm py-2 text-[11px] font-bold disabled:opacity-40"
                          >
                            {asrState === 'running'
                              ? (asrPhase === 'transcribing'
                                ? ((t as any).asrTranscribing || 'Transcribing…')
                                : asrPhase === 'loading-wasm'
                                  ? ((t as any).asrLoadingWasm || 'Loading engine…')
                                  : ((t as any).asrLoading || 'Loading model…'))
                              : (karaokeLines
                                ? ((t as any).asrRecognizeAgain || 'Recognize again')
                                : ((t as any).asrRecognize || 'Recognize lyrics'))}
                          </button>
                          <p className="text-[9px] font-mono text-[var(--text-dim)]">
                            {(t as any).asrSlow || 'Fully offline — on CPU this can take a minute'}
                          </p>
                          {asrState === 'error' && (
                            <div className="flex items-center gap-2">
                              <p className="flex-1 min-w-0 truncate text-[10px] text-red-400 font-mono">{asrError}</p>
                              <button onClick={handleRecognizeLyrics} className="shrink-0 text-[10px] font-mono text-[var(--accent)] underline">
                                {(t as any).asrRetry || 'Retry'}
                              </button>
                            </div>
                          )}
                          {karaokeLines && (
                            <div className="space-y-1.5">
                              <div className="flex gap-1.5">
                                {(['karaoke', 'subs'] as const).map((st) => (
                                  <label key={st} className={`flex-1 bg-black border rounded-sm px-2 py-2 text-[11px] cursor-pointer ${karaokeStyle === st ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}>
                                    <input type="radio" name="karaokeStyle" className="accent-[var(--accent)] mr-1.5" checked={karaokeStyle === st} onChange={() => setKaraokeStyle(st)} />
                                    {st === 'karaoke' ? ((t as any).styleKaraoke || 'Karaoke') : ((t as any).styleSubs || 'Subtitles')}
                                  </label>
                                ))}
                              </div>
                              <div className="max-h-[180px] overflow-y-auto space-y-1 pr-1">
                                {karaokeLines.map((seg, i) => (
                                  <div key={i} className="flex items-center gap-1.5">
                                    <span className="shrink-0 w-[86px] text-[8px] font-mono text-[var(--text-dim)]">
                                      {seg.start.toFixed(1)}–{seg.end.toFixed(1)}s
                                    </span>
                                    <input
                                      type="text"
                                      value={seg.text}
                                      onChange={(e) => setKaraokeLines((karaokeLines || []).map((s, j) => (j === i ? { ...s, text: e.target.value } : s)))}
                                      className="flex-1 min-w-0 bg-black border border-[var(--border)] rounded-sm px-1.5 py-1 text-[10px] focus:outline-none"
                                    />
                                    <button
                                      onClick={() => setKaraokeLines((karaokeLines || []).filter((_, j) => j !== i))}
                                      className="shrink-0 text-[10px] text-[var(--text-dim)] hover:text-red-400"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ))}
                              </div>
                              <p className="text-[9px] font-mono text-[var(--text-dim)]">
                                {(t as any).linesHint || 'Edit the text before export — ASR on music is imperfect'}
                              </p>
                              <button
                                onClick={() => downloadBlob(new Blob([segmentsToSrt(karaokeLines)], { type: 'text/plain;charset=utf-8' }), `${metadata.title || 'master'}_NeuralMaster.srt`)}
                                className="w-full bg-black border border-[var(--border)] rounded-sm py-2 text-[11px] hover:border-[var(--accent)]"
                              >
                                {(t as any).srtBtn || 'Download .srt'}
                              </button>
                            </div>
                          )}
                          {!karaokeLines && asrState !== 'running' && (
                            <p className="text-[10px] text-yellow-400 font-mono">
                              {(t as any).needLines || 'Recognize lyrics before exporting with subtitles'}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <button
            onClick={handleExport}
            disabled={!track || isProcessing || (exportAudio && exportFormat === 'aac' && aacState !== 'ready') || (!exportAudio && !exportVideo) || (exportVideo && karaokeOn && !karaokeLines)}
            className="btn-primary mt-auto flex flex-col items-center justify-center py-3"
          >
            <span>{isExportingVideo ? (t.recordingVideo || "Recording Video...") : isProcessing ? t.exporting : t.export}</span>
          </button>
        </aside>
      </main>

      {/* Footer */}
      <footer className="h-[32px] bg-black border-t border-[var(--border)] shrink-0 px-5 flex items-center justify-between">
        <div className="text-[10px] text-[var(--text-dim)] uppercase tracking-wide">
          {t.procReady}
        </div>
        <div className="flex items-center gap-4">
          <Languages size={12} className="text-[var(--text-dim)]" />
          <div className="flex gap-3 text-[10px] font-bold uppercase">
            {(['en', 'ru', 'zh', 'fr', 'es', 'it', 'ja', 'ko', 'ar'] as Language[]).map(l => (
              <button 
                key={l}
                onClick={() => setLang(l)}
                className={cn(lang === l ? "text-[var(--accent)]" : "text-[var(--text-dim)] hover:text-white")}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </footer>

      {/* Overlays */}
      {/* AnimatePresence keys unkeyed children as "" — two present at once
          (e.g. "Mastering" exit + "Done" enter) trip React's duplicate-key
          warning, so each overlay needs a stable key. */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div
            key="processing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-x-0 bottom-0 top-[60px] z-[100] bg-black/90 backdrop-blur-md flex flex-col items-center justify-center space-y-6"
          >
            <div className="w-16 h-16 border-2 border-[var(--accent)]/20 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            <div className="text-center">
              <h3 className="text-lg font-bold text-white tracking-widest uppercase">{t.rendering}</h3>
              <p className="text-[10px] text-[var(--text-dim)] uppercase tracking-wider mt-2">
                 {isExportingVideo && duration > 0 ? (
                    <VideoExportProgress engineRef={audioEngine} duration={duration} />
                 ) : t.neuralProgress}
              </p>
            </div>
          </motion.div>
        )}

        {showDone && (
          <motion.div
            key="done"
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 50, opacity: 0 }}
            className="fixed bottom-12 left-1/2 -translate-x-1/2 z-[100] bg-[var(--accent)] text-black px-8 py-3 rounded-sm shadow-2xl flex items-center gap-3 font-bold uppercase text-xs"
          >
            <CheckCircle2 size={18} />
            {t.done}
          </motion.div>
        )}

        {autoMasterNote && (
          <motion.div
            key="auto-note"
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 50, opacity: 0 }}
            className="fixed bottom-12 left-1/2 -translate-x-1/2 z-[100] bg-[var(--accent)] text-black px-8 py-3 rounded-sm shadow-2xl flex items-center gap-3 font-bold text-xs max-w-[640px]"
          >
            <Sparkles size={16} className="shrink-0" />
            <span className="truncate">{autoMasterNote}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {showLlmSettings && (
        <LlmSettingsModal
          config={llmConfig}
          lang={lang}
          onSave={(cfg) => { setLlmConfig(cfg); setShowLlmSettings(false); }}
          onClose={() => setShowLlmSettings(false)}
        />
      )}

      {toast && (
        <div
          role="alert"
          className={`fixed bottom-12 right-6 z-[110] max-w-md px-4 py-3 rounded-sm border shadow-2xl text-[11px] font-mono leading-relaxed ${
            toast.kind === 'error'
              ? 'bg-[#1a0d0d] border-red-500/50 text-red-300'
              : 'bg-[#1a150d] border-yellow-500/50 text-yellow-200'
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
