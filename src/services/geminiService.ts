import { MasteringSettings, TrackMetadata, AudioSnapshot } from "../types";

export const getAutoMasterSettings = async (
  metadata: TrackMetadata, 
  logs?: AudioSnapshot[]
): Promise<Partial<MasteringSettings>> => {
  try {
    // Extract technical context from logs
    const original = logs ? [...logs].reverse().find(l => l.label.includes("Original") || l.label.includes("Оригинал")) : undefined;
    const reference = logs ? [...logs].reverse().find(l => l.label.includes("Reference") || l.label.includes("Референс")) : undefined;
    
    // Default fallback settings if no reference or original track is analyzed yet
    let settings: Partial<MasteringSettings> = {
      gain: 2.5,
      lowShelf: 1.0,
      midRange: 0.0,
      highShelf: 1.5,
      compression: 0.25,
      limiter: -0.5,
      saturation: 2.0,
      exciterAmount: 1.5,
      fundamentalFreq: 60,
      haasAmount: 0,
      stereoWidth: 5,
    };

    if (original && reference) {
      // 1. Gain Matching (Match RMS)
      const rmsDiff = reference.levels.rms - original.levels.rms;
      // Clamp between -18 and 18, applying 80% to leave room for limiter
      settings.gain = Math.max(-18, Math.min(18, rmsDiff * 0.8));

      // 2. Spectral Matching (EQ)
      // Extract differences across bands
      const lowDiff = reference.spectrum.low - original.spectrum.low;
      const midDiff = reference.spectrum.mid - original.spectrum.mid;
      const highDiff = reference.spectrum.high - original.spectrum.high;

      // Map spectral diffs (usually small numbers like 0.1 to 0.8) to dB adjustments (-10 to 10)
      // We'll scale them by a factor (e.g. 15) to make it noticeable but safe
      settings.lowShelf = Math.max(-10, Math.min(10, lowDiff * 15));
      settings.midRange = Math.max(-10, Math.min(10, midDiff * 10));
      settings.highShelf = Math.max(-10, Math.min(10, highDiff * 15));

      // Match sub frequencies by tuning fundamentalFreq. If reference has heavy sub, we assume ~50Hz focus, else 80Hz.
      if (reference.spectrum.sub > 0.45) {
        settings.fundamentalFreq = 50; 
      } else if (reference.spectrum.sub < 0.2) {
        settings.fundamentalFreq = 100;
      } else {
        settings.fundamentalFreq = 70;
      }

      // 3. Dynamics
      // If original has higher crest factor (more dynamic) than reference, we compress more.
      const crestDiff = original.levels.crestFactor - reference.levels.crestFactor;
      settings.compression = Math.max(-5, Math.min(5, crestDiff * 0.5));
      settings.limiter = Math.max(-5, Math.min(5, (reference.levels.peak > -1.0 ? -0.5 : -2.0))); // Harder limiter if target is loud

      // 4. Texture & Saturation
      // High frequency content and density difference roughly correlates to saturation and exciter
      if (reference.spectrum.high > original.spectrum.high) {
        settings.exciterAmount = Math.max(0, Math.min(10, (reference.spectrum.high - original.spectrum.high) * 20));
      } else {
        settings.exciterAmount = 0.5; // default gentle
      }
      
      // Saturation derived from RMS mapping (louder target often means more harmonic density)
      if (rmsDiff > 3) {
        settings.saturation = Math.max(0, Math.min(10, rmsDiff * 0.5));
      } else {
        settings.saturation = 1.0;
      }

      // 5. Stereo Width
      const widthDiff = reference.stereo.width - original.stereo.width;
      // Map 0.0-1.0 width difference to -50 to 50 scale
      settings.stereoWidth = Math.max(-50, Math.min(50, widthDiff * 60));
    }

    // Round values to 2 decimal places to keep them clean
    Object.keys(settings).forEach(key => {
      const k = key as keyof MasteringSettings;
      if (typeof settings[k] === 'number') {
        (settings as any)[k] = Number((settings[k] as number).toFixed(2));
      }
    });

    return settings;
  } catch (error) {
    console.error("Algorithmic Mastering Error:", error);
    return {};
  }
};
