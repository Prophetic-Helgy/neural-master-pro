/**
 * presets.ts — platform mastering presets for the Lite (one-click) mode.
 *
 * Targets are the standard 2025–2026 platform specs — hard loudness numbers:
 *   Spotify / YouTube   −14 LUFS / −1.0 dBTP
 *   TikTok / Shorts     −10 LUFS / −1.0 dBTP (loud short-form)
 *   Apple Music         −16 LUFS / −1.0 dBTP
 *   Club                −11 LUFS / −1.0 dBTP
 *   Radio               −13 LUFS / −1.0 dBTP
 *   Classical / Piano   −20 LUFS / −2.0 dBTP (soft, dynamics preserved)
 *   Lullaby             −20 LUFS / −3.0 dBTP (soft, extra headroom)
 *   Podcast             −16 LUFS / −2.0 dBTP
 *
 * The profile only shapes tone/dynamics — delivered loudness is always
 * exactly the requested target (see chooseParams in masteringPipeline.ts).
 * "Custom" is a virtual preset: the user sets target/ceiling/profile.
 */
import type { PipelineSettings, ProfileId } from './masteringPipeline.ts';

export interface LitePreset {
  id: string;
  /** i18n key for the chip label. */
  labelKey: string;
  targetLufs: number;
  ceilingDb: number;
  profile: ProfileId;
}

export const LITE_PRESETS: LitePreset[] = [
  { id: 'spotify', labelKey: 'presetSpotify', targetLufs: -14, ceilingDb: -1.0, profile: 'balanced' },
  { id: 'youtube', labelKey: 'presetYouTube', targetLufs: -14, ceilingDb: -1.0, profile: 'balanced' },
  { id: 'tiktok', labelKey: 'presetTikTok', targetLufs: -10, ceilingDb: -1.0, profile: 'loud' },
  { id: 'apple', labelKey: 'presetApple', targetLufs: -16, ceilingDb: -1.0, profile: 'balanced' },
  { id: 'club', labelKey: 'presetClub', targetLufs: -11, ceilingDb: -1.0, profile: 'loud' },
  { id: 'radio', labelKey: 'presetRadio', targetLufs: -13, ceilingDb: -1.0, profile: 'streaming' },
  { id: 'classical', labelKey: 'presetClassical', targetLufs: -20, ceilingDb: -2.0, profile: 'soft' },
  { id: 'lullaby', labelKey: 'presetLullaby', targetLufs: -20, ceilingDb: -3.0, profile: 'soft' },
  { id: 'podcast', labelKey: 'presetPodcast', targetLufs: -16, ceilingDb: -2.0, profile: 'streaming' },
];

export const CUSTOM_PRESET_ID = 'custom';

export interface CustomPresetParams {
  targetLufs: number;   // −20..−8
  ceilingDb: number;    // −3.0..−0.3
  profile: ProfileId;
}

export const DEFAULT_CUSTOM: CustomPresetParams = {
  targetLufs: -14,
  ceilingDb: -1.0,
  profile: 'balanced',
};

/** Map a preset (or the custom params) to pipeline settings. */
export function presetToSettings(
  preset: LitePreset | null,
  custom: CustomPresetParams = DEFAULT_CUSTOM
): PipelineSettings {
  if (preset && preset.id !== CUSTOM_PRESET_ID) {
    return { targetLufs: preset.targetLufs, ceilingDb: preset.ceilingDb, profile: preset.profile };
  }
  return { targetLufs: custom.targetLufs, ceilingDb: custom.ceilingDb, profile: custom.profile };
}
