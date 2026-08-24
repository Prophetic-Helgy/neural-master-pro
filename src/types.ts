export type Language = 'en' | 'ru' | 'zh' | 'fr' | 'es' | 'ar' | 'ja' | 'ko' | 'it';

export interface TimelinePoint {
  t: number;      // timestamp in seconds
  rms: number;    // dB
  peak: number;   // dB
  w: number;      // width (0-1)
}

export interface AudioSnapshot {
  timestamp: number;
  label: string;
  bpm?: number;
  levels: {
    peak: number;
    rms: number;
    lufs: number;
    crestFactor: number; // Peak to RMS ratio
  };
  /** 4x-oversampled true peak, dBTP (set when the full measurement ran). */
  truePeakDb?: number;
  /** BS.1770-4 loudness range, LU. */
  lra?: number;
  /** Max |DC offset| across channels, dB. */
  dcOffsetDb?: number;
  spectrum: {
    sub: number;    // 20-60Hz
    low: number;    // 60-250Hz
    lowMid: number; // 250-500Hz
    mid: number;    // 500-2kHz
    highMid: number;// 2k-6kHz
    high: number;   // 6k-20kHz
  };
  stereo: {
    correlation: number;
    width: number;
  };
  timeline?: TimelinePoint[];
  settings?: MasteringSettings;
}

export interface MasteringSettings {
  gain: number;
  lowShelf: number;
  midRange: number;
  highShelf: number;
  compression: number;
  limiter: number;
  saturation: number;
  stereoWidth: number;
  fundamentalFreq: number;
  exciterAmount: number;
  exciterFreq: number;
  haasAmount: number; // 0 to 100 ms
  dithering: boolean;
  eq31: number;
  eq62: number;
  eq125: number;
  eq250: number;
  eq500: number;
  eq1k: number;
  eq2k: number;
  eq4k: number;
  eq8k: number;
  eq16k: number;
  autotune: number;
  reverb: number;
  distortion: number;
  delay: number;
  chorus: number;
  // Bass Stem FX
  bass_autotune: number;
  bass_reverb: number;
  bass_distortion: number;
  bass_delay: number;
  bass_chorus: number;
  // Mid Stem FX
  mid_autotune: number;
  mid_reverb: number;
  mid_distortion: number;
  mid_delay: number;
  mid_chorus: number;
  // Side Stem FX
  side_autotune: number;
  side_reverb: number;
  side_distortion: number;
  side_delay: number;
  side_chorus: number;
}

export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  genre: string;
  year?: string;
  label?: string;
  bpm?: number;
  key?: string;
  coverArt?: string;
}

export type ExportFormat = 'wav' | 'mp3' | 'aac' | 'flac';
export type ExportQuality = 'low' | 'medium' | 'high' | 'ultra';

export type TargetStem = 'master' | 'bass' | 'mid' | 'side';

export interface EffectRegion {
  id: string;
  start: number;
  end: number;
  targetStem: TargetStem;
  color?: string;
  effects: {
    autotune: number;
    reverb: number;
    distortion: number;
    delay: number;
    chorus: number;
  };
}

export interface PexelsVideoFile {
  id: number;
  quality: string;
  file_type: string;
  width: number;
  height: number;
  fps: number;
  link: string;
  size: number;
}

export interface PexelsClip {
  id: number;
  duration: number;
  image: string;
  user: { name: string; url: string };
  video_files: PexelsVideoFile[];
}
