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
import { i18n } from './lib/i18n';
import { Language, MasteringSettings, TrackMetadata, ExportFormat, ExportQuality, AudioSnapshot, EffectRegion, TargetStem, PexelsClip, PexelsVideoFile } from './types';
import type { PipelineMetrics } from './lib/audioMeters';
import { AudioVisualizer } from './components/AudioVisualizer';
import { MasteringControl } from './components/MasteringControl';
import { MeteringBridge } from './components/MeteringBridge';
import { DiagnosticPanel } from './components/DiagnosticPanel';
import { LiteMaster } from './components/LiteMaster';
import { getAutoMasterSettings } from './services/geminiService';
import { searchPexelsVideos, pickBestRendition, ensureClipBlob, PexelsApiError } from './services/pexelsService';
import { loadLlmConfig, saveLlmConfig, llmAutoMaster, llmAiReport, LlmConfig, LlmError } from './services/llmService';
import { LlmSettingsModal } from './components/LlmSettingsModal';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { GraphicEQ } from './components/GraphicEQ';

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

  // New states
  const [monitorVolume, setMonitorVolume] = useState(1);
  const [playbackSpeed, setPlaybackSpeed] = useState(0);
  const [trimStart, setTrimStart] = useState<number | string>(0);
  const [trimEnd, setTrimEnd] = useState<number | string>(0);
  const hasAutoTrimRef = useRef(false);
  const logoRef = useRef<HTMLImageElement>(null);
  const [effectRegions, setEffectRegions] = useState<EffectRegion[]>([]);
  const [activeFXRegionId, setActiveFXRegionId] = useState<string | null>(null);

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
    const pulseLogo = () => {
      if (isPlaying && logoRef.current && audioEngine.current) {
        const analysers = audioEngine.current.getAnalysers();
        if (analysers && analysers.L) {
          const timeData = new Uint8Array(analysers.L.frequencyBinCount);
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
    if (typeof window !== 'undefined' && (window as any).require) {
      try {
        const { ipcRenderer } = (window as any).require('electron');
        ipcRenderer.invoke('get-hardware-info').then((info: any) => {
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
      // @ts-ignore
      if (typeof window !== 'undefined' && window.require) {
        try {
          // @ts-ignore
          const { ipcRenderer } = window.require('electron');
          if (ipcRenderer) {
            const stats = await ipcRenderer.invoke('get-hardware-temps');
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

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [visMode, setVisMode] = useState<'bars' | 'circle' | 'wave' | 'alchemy' | 'circles' | 'flight' | 'smoke'>('bars');
  const [monitoringMode, setMonitoringMode] = useState<'master' | 'source' | 'reference'>('source');
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
  const [exportCanvasNode, setExportCanvasNode] = useState<HTMLCanvasElement | null>(null);
  const [isExportingVideo, setIsExportingVideo] = useState(false);

  // Pexels stock-video background states
  const [videoBgMode, setVideoBgMode] = useState<'visualizer' | 'pexels'>('visualizer');
  const [pexelsQuery, setPexelsQuery] = useState('');
  const [pexelsResults, setPexelsResults] = useState<PexelsClip[]>([]);
  const [pexelsSearching, setPexelsSearching] = useState(false);
  const [selectedClip, setSelectedClip] = useState<PexelsClip | null>(null);
  const [selectedFile, setSelectedFile] = useState<PexelsVideoFile | null>(null);
  const [clipDl, setClipDl] = useState<{ s: 'idle' | 'downloading' | 'ready' | 'error'; p: number }>({ s: 'idle', p: 0 });
  const [pexelsClipUrl, setPexelsClipUrl] = useState<string | null>(null);
  const [pexelsError, setPexelsError] = useState<string | null>(null);
  const [showCredit, setShowCredit] = useState(true);
  const [bgVideoEl, setBgVideoEl] = useState<HTMLVideoElement | null>(null);
  const pendingDownloadRef = useRef<Promise<string | null> | null>(null);
  const pexelsClipUrlRef = useRef<string | null>(null);

  const audioEngine = useRef<AudioEngine | null>(null);
  const t = i18n[lang];

  // Keep the latest object URL in a ref so unmount cleanup revokes the right one
  useEffect(() => {
    pexelsClipUrlRef.current = pexelsClipUrl;
  }, [pexelsClipUrl]);

  useEffect(() => () => {
    if (pexelsClipUrlRef.current) URL.revokeObjectURL(pexelsClipUrlRef.current);
  }, []);

  useEffect(() => {
    audioEngine.current = new AudioEngine();
    audioEngine.current.setOnEnded(() => setIsPlaying(false));
    audioEngine.current.setOnError((msg) => showToast(msg, 'error'));
    
    // Apply default settings and initial monitoring mode immediately on init
    audioEngine.current.updateSettings(settings);
    audioEngine.current.setBypass(true); // Since source is default
    
    // Polling for time progress
    const interval = setInterval(() => {
      if (audioEngine.current) {
        setCurrentTime(audioEngine.current.getCurrentTime());
      }
    }, 100);

    return () => clearInterval(interval);
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

      audioEngine.current.measureTrack(audioEngine.current.getBuffer())
        .then(setTrackMetrics)
        .finally(() => setTrackMetricsBusy(false));
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
        setCoverArt(ev.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const togglePlayback = () => {
    if (!audioEngine.current || !track) return;
    if (isPlaying) {
      audioEngine.current.stop();
    } else {
      audioEngine.current.play();
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
      setCurrentTime(time);
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
    setSettings(NEUTRAL_SETTINGS);
    audioEngine.current?.updateSettings(NEUTRAL_SETTINGS);
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

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const isVert = videoOrientation === 'vertical';
  const baseW = videoRes === 'fhd' ? 1080 : videoRes === '2k' ? 1440 : 2160;
  const baseH = videoRes === 'fhd' ? 1920 : videoRes === '2k' ? 2560 : 3840;
  const expW = isVert ? baseW : baseH;
  const expH = isVert ? baseH : baseW;

  const resetPexelsSelection = () => {
    setSelectedClip(null);
    setSelectedFile(null);
    setPexelsResults([]);
    setPexelsError(null);
    setClipDl({ s: 'idle', p: 0 });
    pendingDownloadRef.current = null;
    if (pexelsClipUrl) {
      URL.revokeObjectURL(pexelsClipUrl);
      setPexelsClipUrl(null);
    }
  };

  const runPexelsSearch = async () => {
    const q = pexelsQuery.trim();
    if (!q || pexelsSearching) return;
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

  const handleClipSelect = (clip: PexelsClip) => {
    const file = pickBestRendition(clip.video_files, expW, expH);
    if (!file) {
      setPexelsError('No usable video file for this clip');
      return;
    }
    setSelectedClip(clip);
    setSelectedFile(file);
    setPexelsError(null);
    setClipDl({ s: 'downloading', p: 0 });
    if (pexelsClipUrl) {
      URL.revokeObjectURL(pexelsClipUrl);
      setPexelsClipUrl(null);
    }
    // All async work lives in the click handler (StrictMode-safe, no useEffect fetches)
    const p = ensureClipBlob(file, prog => setClipDl({ s: 'downloading', p: prog }))
      .then(blob => {
        const url = URL.createObjectURL(blob);
        setPexelsClipUrl(url);
        setClipDl({ s: 'ready', p: 1 });
        return url;
      })
      .catch((e: any) => {
        setClipDl({ s: 'error', p: 0 });
        const msg = e instanceof PexelsApiError ? ((t as any).pexelsError || 'Pexels error: {code}').replace('{code}', e.code) : (e?.message || 'Download failed');
        setPexelsError(msg);
        return null;
      });
    pendingDownloadRef.current = p;
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

  const handleExport = async () => {
    if (!track || !audioEngine.current || (!exportAudio && !exportVideo)) return;
    setIsProcessing(true);

    try {
      const fileNameBase = metadata.title || 'master';

      if (exportAudio) {
        // Offline Faust render → shared encoder (dithered WAV / MP3 / FLAC / AAC + metadata).
        const pcm = await audioEngine.current.renderProPcm(settings, Number(trimStart) || 0, Number(trimEnd) || 0, effectRegions);
        if (!pcm) throw new Error('Pro render failed — engine not ready');
        const enc = await encodeAudio(pcm.left, pcm.right, pcm.sampleRate, {
          format: exportFormat,
          bitDepth: exportFormat === 'wav' ? proWavBit : undefined,
          aacKbps: exportFormat === 'aac' ? aacKbps : undefined,
          metadata,
        });
        downloadBlob(enc.blob, `${fileNameBase}_NeuralMaster.${enc.ext}`);
      }

      if (exportVideo && exportCanvasNode) {
        // Wait for the Pexels background clip to finish downloading
        if (pendingDownloadRef.current) {
          await pendingDownloadRef.current;
        }

        // Pexels background: seek to 0 and wait for the first frame (up to 8s),
        // BEFORE the audio starts — otherwise the clip and the track desync.
        // If it never becomes ready, the draw loop simply skips the video frame
        // (readyState guard), so the export degrades to the visualizer only.
        if (videoBgMode === 'pexels' && pexelsClipUrl && bgVideoEl) {
          if (bgVideoEl.readyState >= 1) bgVideoEl.currentTime = 0;
          bgVideoEl.play().catch(() => {});
          const waitStart = Date.now();
          while (bgVideoEl.readyState < 2 && Date.now() - waitStart < 8000) {
            await new Promise(r => setTimeout(r, 100));
          }
          if (bgVideoEl.readyState < 2) {
            console.warn('[NMP] Pexels background not ready in 8s — exporting visualizer only');
          }
        }

        // Record the processed MASTER regardless of the current monitor/bypass —
        // otherwise a user monitoring the dry source exports unprocessed audio.
        const savedBypass = audioEngine.current.getBypass();
        if (savedBypass) {
          audioEngine.current.setBypass(false);
          await new Promise(r => setTimeout(r, 150)); // let the 20 ms switch gains settle
        }

        // Honor the trim region: start at trimStart, record to trimEnd (capped at track end).
        const recStart = Math.min(Number(trimStart) || 0, duration);
        const recEnd = Math.min(Number(trimEnd) || 0, duration) || duration;
        const recLenSec = Math.max(0, recEnd - recStart);

        setIsExportingVideo(true);
        audioEngine.current.seek(recStart);
        audioEngine.current.play();
        setIsPlaying(true);

        const dest = audioEngine.current.getAudioContext().createMediaStreamDestination();
        audioEngine.current.getMonitorGain().connect(dest);

        const videoStream = exportCanvasNode.captureStream(videoFps);
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
        const chunks: BlobPart[] = [];
        recorder.ondataavailable = e => { if(e.data.size) chunks.push(e.data); };
        
        const videoPromise = new Promise<void>((resolve, reject) => {
          let reqId: number;
          if (exportCanvasNode) {
            const ctx = exportCanvasNode.getContext('2d');
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
             reject(e);
          };
        });

        recorder.start(100); // 100ms chunks to stop 4K freezing and OOM!

        const ms = recLenSec * 1000;
        await new Promise(r => setTimeout(r, ms + 100)); // wait for the trimmed region to play

        recorder.stop();
        bgVideoEl?.pause();
        // With trimEnd < track end the source is still playing — stop it and
        // restore the user's monitor mode.
        audioEngine.current.stop();
        audioEngine.current.getMonitorGain().disconnect(dest);
        audioEngine.current.setBypass(savedBypass);
        setIsPlaying(false);
        await videoPromise;
        setIsExportingVideo(false);
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
      {/* Hidden high-res canvas for video export */}
      <div style={{ position: 'fixed', top: '-9999px', left: '-9999px', opacity: 0.01, pointerEvents: 'none' }}>
        <AudioVisualizer
          analyser={audioEngine.current?.getAnalysers()?.L || null}
          mode={visMode}
          coverArt={coverArt || './logo_Neural Master Pro.png'}
          width={expW}
          height={expH}
          exportMode={true}
          metadata={metadata}
          onCanvasReady={setExportCanvasNode}
          bgVideoUrl={videoBgMode === 'pexels' ? pexelsClipUrl : null}
          creditText={videoBgMode === 'pexels' && showCredit && selectedClip ? `${(t as any).videoAuthor || 'Video:'} Pexels / ${selectedClip.user.name}` : null}
          onBgVideoReady={setBgVideoEl}
        />
      </div>

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
               if (typeof window !== 'undefined' && (window as any).require) {
                 const { ipcRenderer } = (window as any).require('electron');
                 ipcRenderer.send('minimize-app');
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
               if (typeof window !== 'undefined' && (window as any).require) {
                 const { ipcRenderer } = (window as any).require('electron');
                 ipcRenderer.send('close-app');
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
            <AudioVisualizer mode={visMode} analyser={audioEngine.current?.getAnalysers().L || null} coverArt={coverArt || "./logo_Neural Master Pro.png"} />
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
          {/* Stem Selector for FX */}
          <div className="mb-2 flex items-center justify-center gap-1 border border-[#222] bg-[#0c0d11] p-1 rounded-sm">
            {[
              { id: 'master', label: (t as any).stemMaster || 'MASTER' },
              { id: 'bass', label: (t as any).stemBass || 'BASS (LOWS)' },
              { id: 'mid', label: (t as any).stemMid || 'MID (VOCALS/CENTER)' },
              { id: 'side', label: (t as any).stemSide || 'SIDE (INSTRUMENTS/WIDTH)' },
            ].map(stem => (
              <button
                key={stem.id}
                onClick={() => setActiveStem(stem.id as TargetStem)}
                className={`flex-1 text-[9px] font-bold py-1.5 rounded-sm transition-all ${activeStem === stem.id ? 'bg-[var(--accent)] text-black' : 'text-[var(--text-dim)] hover:bg-[#1a1c22] hover:text-white'}`}
              >
                {stem.label}
              </button>
            ))}
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
          </>)}

          {/* Seek Bar */}
          <div className="mb-2 space-y-1 relative">
            <div className="flex justify-between text-[10px] font-mono text-[var(--text-dim)] mb-1">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
            <div className="relative w-full h-[6px] flex items-center bg-[#1a1c22] rounded-full overflow-hidden">
              <div 
                className="absolute left-0 top-0 h-full bg-[#333] transition-all rounded-full pointer-events-none" 
                style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
              />
              <input 
                type="range"
                min="0"
                max={duration || 100}
                step="0.01"
                value={currentTime}
                onChange={(e) => handleSeek(parseFloat(e.target.value))}
                disabled={!track}
                className="absolute top-0 left-0 w-full h-[12px] appearance-none bg-transparent m-0 p-0 cursor-pointer outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-sm disabled:opacity-10 z-20"
              />
            </div>
          </div>

          {/* Metering Bridge */}
          <MeteringBridge isPlaying={isPlaying} analysers={audioEngine.current?.getAnalysers() || null} lang={lang} />
        </section>

        {/* Right: Info & Export */}
        <aside className="bg-[var(--panel)] p-5 overflow-y-auto flex flex-col gap-6">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--text-dim)] mb-3">{t.metadata}</div>
            <div 
              onClick={() => document.getElementById('cover-upload')?.click()}
              className="aspect-square bg-black border-2 border-dashed border-[var(--border)] flex flex-col items-center justify-center text-[11px] text-[var(--text-dim)] rounded-lg hover:border-[var(--accent)]/40 transition-colors cursor-pointer group overflow-hidden relative"
            >
              {coverArt ? (
                <img src={coverArt} alt="Cover Art" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
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
                          <div className="grid grid-cols-3 gap-1.5 max-h-[220px] overflow-y-auto pr-1">
                            {pexelsResults.map(clip => (
                              <button
                                key={clip.id}
                                onClick={() => handleClipSelect(clip)}
                                className={`relative rounded-sm overflow-hidden border ${selectedClip?.id === clip.id ? "border-[var(--accent)] shadow-[0_0_8px_rgba(255,0,128,0.4)]" : "border-[var(--border)]"}`}
                              >
                                <img src={clip.image} alt="" className="w-full aspect-[9/16] object-cover" loading="lazy" referrerPolicy="no-referrer" />
                                <span className="absolute bottom-0 inset-x-0 bg-black/70 text-[8px] font-mono text-white px-1 py-0.5 flex items-center justify-between">
                                  <span>{Math.round(clip.duration)}s</span>
                                  <span className="truncate ml-1 max-w-[70%]">{clip.user.name}</span>
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        {selectedClip && (
                          <div className="space-y-1.5">
                            {clipDl.s === 'downloading' && (
                              <div>
                                <div className="h-1 bg-[#1a1c22] rounded-sm overflow-hidden">
                                  <div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${Math.round(clipDl.p * 100)}%` }} />
                                </div>
                                <p className="text-[10px] font-mono text-[var(--text-dim)] mt-1">{(t as any).downloading || "Downloading…"} {Math.round(clipDl.p * 100)}%</p>
                              </div>
                            )}
                            {clipDl.s === 'error' && (
                              <button onClick={() => { if (selectedClip) handleClipSelect(selectedClip); }} className="w-full bg-black border border-red-500/50 text-red-400 rounded-sm px-2 py-2 text-[11px]">
                                {(t as any).retryDownload || "Retry download"}
                              </button>
                            )}
                            {clipDl.s === 'ready' && (
                              <label className="flex items-start gap-1.5 text-[10px] font-mono cursor-pointer text-[var(--text-dim)]">
                                <input type="checkbox" checked={showCredit} onChange={(e) => setShowCredit(e.target.checked)} className="accent-[var(--accent)] mt-px" />
                                <span>{((t as any).videoCredit || 'Show "Video: Pexels / {author}" credit in clip').replace('{author}', selectedClip.user.name)}</span>
                              </label>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <button 
            onClick={handleExport}
            disabled={!track || isProcessing || (exportAudio && exportFormat === 'aac' && aacState !== 'ready') || (!exportAudio && !exportVideo)}
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
      <AnimatePresence>
        {isProcessing && (
          <motion.div 
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
                    `${Math.min(100, Math.floor((currentTime / duration) * 100))}% - ETA: ${formatTime(duration - currentTime)}`
                 ) : t.neuralProgress}
              </p>
            </div>
          </motion.div>
        )}

        {showDone && (
          <motion.div 
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
