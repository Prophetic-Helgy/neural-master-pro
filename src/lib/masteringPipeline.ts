/**
 * masteringPipeline.ts — offline "Smart Master" pipeline (pure TypeScript).
 *
 * Deterministic loudness/peak-to-target mastering for AI-generated tracks:
 *   DC removal → subsonic HPF 26Hz → auto-EQ (low shelf 95Hz, mud 285Hz,
 *   de-harsh peaking on the measured 2-5kHz peak, air shelf 9.2kHz) →
 *   soft-knee bus compressor (params derived from crest/loudness push) →
 *   optional de-ess 6.5kHz → stereo-width correction → light saturation →
 *   anti-alias LPF 19kHz → two-pass loudness normalization with a
 *   verification loop → ISP look-ahead limiter (4x-oversampled envelope,
 *   monotonic deque, 6 ms) → 24/32f/16-bit WAV encoding (wavEncode.ts).
 *
 * The auto-parameter formulas are derived from the reference Suno mastering
 * tool's published bundle (ported 1:1), with two upgrades:
 *   1. soft-knee (6 dB) compressor gain curve instead of a hard knee
 *   2. true 4x-oversampled (ISP) peak envelope for the limiter instead of
 *      raw sample peaks — inter-sample peaks cannot escape the ceiling.
 *
 * All passes run on the main thread in chunks (~2-4 M samples + a macrotask
 * yield) so long files never freeze the UI and progress is reportable.
 * This is a Web Worker replacement: it works identically under Vite dev
 * (http) and packaged Electron (file://), where workers are unreliable.
 */

import {
  applyBiquad,
  biquadCoeffs,
  clamp,
  computeIspEnvelope,
  dbToLin,
  linToDb,
  measureLoudnessLra,
  measureMetrics,
  removeDcInPlace,
  type BiquadType,
  type PipelineMetrics,
} from './audioMeters.ts';

// ---------------------------------------------------------------------------
// Profiles & settings
// ---------------------------------------------------------------------------

export type ProfileId = 'balanced' | 'streaming' | 'loud' | 'soft';

export interface PipelineProfile {
  targetOffset: number;
  comp: number;
  width: number;
  bright: number;
  drive: number;
}

export const PROFILES: Record<ProfileId, PipelineProfile> = {
  balanced: { targetOffset: 0, comp: 1, width: 1, bright: 1, drive: 1 },
  streaming: { targetOffset: -2, comp: 0.82, width: 0.95, bright: 0.85, drive: 0.78 },
  loud: { targetOffset: 1.3, comp: 1.25, width: 1.04, bright: 1.08, drive: 1.25 },
  soft: { targetOffset: -3, comp: 0.58, width: 0.84, bright: 0.62, drive: 0.55 },
};

export interface PipelineSettings {
  /** Target integrated loudness, LU (UI: -20..-8). */
  targetLufs: number;
  /** True-peak ceiling, dBTP (UI: -3..-0.3). */
  ceilingDb: number;
  profile: ProfileId;
  /** Processing strength 0..1 (default 0.72). */
  amount?: number;
}

export interface ChosenParams {
  targetLufs: number;
  ceilingDb: number;
  lowShelfDb: number;
  lowMidDb: number;
  harshDb: number;
  harshFreq: number;
  deEssDb: number;
  highShelfDb: number;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
  width: number;
  drive: number;
  saturationMix: number;
  limiterLookaheadMs: number;
  limiterReleaseMs: number;
}

/**
 * Auto-parameter derivation (reference-tool formulas, ported verbatim).
 * Everything is measured, not guessed: EQ corrections come from the tone
 * ratios, dynamics from the crest factor, push from the target loudness.
 */
export function chooseParams(metrics: PipelineMetrics, settings: PipelineSettings, refMetrics?: PipelineMetrics): ChosenParams {
  const tone = metrics.tone;
  const profile = PROFILES[settings.profile] || PROFILES.balanced;
  const amount = clamp(settings.amount ?? 0.72, 0, 1);

  // The requested target is delivered exactly: platform specs (Spotify −14,
  // YouTube −14, Classical −20, …) are hard numbers, and the profile shapes
  // tone/dynamics, not delivered loudness. (The reference bundle applied
  // `targetOffset` here, silently drifting the output up to 0.75 LU from the
  // request.) Range matches the documented UI bounds (−20..−8).
  const targetLufs = clamp(settings.targetLufs ?? -12, -20, -8);

  // Tone targets: absolute reference-tool thresholds by default. With a
  // reference track, the targets become the reference's own tone ratios —
  // the master is steered toward the reference instead of a generic profile.
  // Ref values are clamped to sane ranges so an unbalanced reference cannot
  // drive extreme corrections (the final param clamps bound the damage too).
  const rt = refMetrics ? refMetrics.tone : null;
  const bassTarget = rt ? clamp(rt.bassRatio + rt.subRatio, 0.08, 0.5) : 0.22;
  const mudTarget = rt ? clamp(rt.lowMidRatio, 0.05, 0.45) : 0.2;
  const harshTarget = rt ? clamp(rt.harshRatio, 0.04, 0.4) : 0.18;
  const brightTarget = rt ? clamp(rt.highRatio + rt.airRatio, 0.02, 0.3) : 0.135;

  const lowExcess = tone.bassRatio + tone.subRatio - bassTarget;
  const mudExcess = tone.lowMidRatio - mudTarget;
  const harshExcess = tone.harshRatio - harshTarget;
  const brightNeed = brightTarget - (tone.highRatio + tone.airRatio);
  const dynamicNeed = clamp((metrics.crestFactor - 7) / 7, 0, 1);

  let width = 1 + clamp((0.63 - tone.correlation) * 0.18, -0.1, 0.18) * profile.width * amount;
  if (tone.correlation < 0.08) width = Math.min(width, 0.96);
  width = clamp(width, 0.82, 1.16);

  const loudnessPush = clamp((-11 - targetLufs) / 4, 0, 1);
  const thresholdDb = -18 + dynamicNeed * 4 - loudnessPush * 2;
  const ratio = clamp((1.35 + dynamicNeed * 1.25 + loudnessPush * 0.55) * profile.comp, 1.2, 3.2);

  return {
    targetLufs,
    ceilingDb: clamp(settings.ceilingDb ?? -1, -3.0, -0.3),
    lowShelfDb: clamp(-lowExcess * 8 * amount, -2.5, 1.5),
    lowMidDb: clamp(-mudExcess * 10 * amount, -2.8, 0.8),
    harshDb: clamp(-Math.max(0, harshExcess) * 12 * amount * profile.bright, -4.2, 0),
    harshFreq: clamp(tone.harshPeakHz || 3400, 2400, 5200),
    deEssDb: clamp(-Math.max(0, tone.harshRatio - (harshTarget + 0.05)) * 9 * amount, -3.5, 0),
    highShelfDb: clamp(brightNeed * 9 * amount * profile.bright, -1.2, 2.2),
    thresholdDb,
    ratio,
    attackMs: 18 - dynamicNeed * 8,
    releaseMs: 120 + dynamicNeed * 60,
    makeupDb: clamp(dynamicNeed * 0.8, 0, 1.2),
    width,
    drive: clamp(1 + (0.08 + loudnessPush * 0.24) * amount * profile.drive, 1, 1.38),
    saturationMix: clamp((0.12 + loudnessPush * 0.08) * amount, 0.04, 0.22),
    limiterLookaheadMs: 6,
    limiterReleaseMs: 85 + dynamicNeed * 65,
  };
}

// ---------------------------------------------------------------------------
// Findings (i18n keys are resolved in the UI)
// ---------------------------------------------------------------------------

export interface PipelineFinding {
  level: 'warn' | 'good';
  key: string;
  args?: string[];
}

export function buildFindings(metrics: PipelineMetrics, params: ChosenParams): PipelineFinding[] {
  const tone = metrics.tone;
  const findings: PipelineFinding[] = [];
  if (tone.lowMidRatio > 0.235) findings.push({ level: 'warn', key: 'findMud' });
  if (tone.harshRatio > 0.22) findings.push({ level: 'warn', key: 'findHarsh', args: [String(Math.round(params.harshFreq))] });
  if (metrics.crestFactor > 9) findings.push({ level: 'warn', key: 'findCrest' });
  if (tone.correlation < 0.08) findings.push({ level: 'warn', key: 'findPhase' });
  if (metrics.truePeakDb > -0.4) findings.push({ level: 'warn', key: 'findPeakHeadroom', args: [metrics.truePeakDb.toFixed(1)] });
  if (metrics.dcOffsetDb > -60) findings.push({ level: 'warn', key: 'findDc', args: [metrics.dcOffsetDb.toFixed(0)] });
  if (findings.length === 0) findings.push({ level: 'good', key: 'findBalanced' });
  findings.push({ level: 'good', key: 'findTarget', args: [params.targetLufs.toFixed(1), params.ceilingDb.toFixed(1)] });
  return findings.slice(0, 6);
}

// ---------------------------------------------------------------------------
// DSP building blocks (in-place on Float32Array stereo pairs)
// ---------------------------------------------------------------------------

/**
 * Soft-knee compressor gain reduction (dB, >= 0).
 * C1-continuous curve: identity below T-K/2, slope 1/R above T+K/2,
 * parabolic in the knee.
 */
export function softKneeReductionDb(levelDb: number, threshDb: number, ratio: number, kneeDb = 6): number {
  const u = levelDb - threshDb;
  const h = kneeDb / 2;
  if (u <= -h) return 0;
  if (u >= h) return ((ratio - 1) / ratio) * (u - h);
  const a = (1 - ratio) / (2 * kneeDb * ratio);
  return a * (u * u - h * h);
}

/** Bus compressor with a mono-sum detector and smoothed gain (reference-tool style). */
export function compressStereo(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  params: ChosenParams
): { avgReductionDb: number } {
  const threshold = params.thresholdDb;
  const ratio = params.ratio;
  const attack = Math.exp(-1 / (sampleRate * (params.attackMs / 1000)));
  const release = Math.exp(-1 / (sampleRate * (params.releaseMs / 1000)));
  const makeup = dbToLin(params.makeupDb);

  let env = 0;
  let gain = 1;
  let totalReduction = 0;
  let reductionSamples = 0;

  for (let i = 0; i < left.length; i += 1) {
    const detector = Math.sqrt((left[i] * left[i] + right[i] * right[i]) * 0.5);
    env = detector > env
      ? attack * env + (1 - attack) * detector
      : release * env + (1 - release) * detector;
    const levelDb = linToDb(env);
    const targetGainDb = -softKneeReductionDb(levelDb, threshold, ratio, 6);
    const targetGain = dbToLin(targetGainDb);
    gain = targetGain < gain ? 0.72 * gain + 0.28 * targetGain : 0.996 * gain + 0.004 * targetGain;
    left[i] *= gain * makeup;
    right[i] *= gain * makeup;
    if (targetGainDb < -0.05) {
      totalReduction += -targetGainDb;
      reductionSamples += 1;
    }
  }
  return { avgReductionDb: reductionSamples ? totalReduction / reductionSamples : 0 };
}

/** Mid/Side width adjustment (1 = unchanged, <1 narrows, >1 widens). */
export function adjustStereoWidth(left: Float32Array, right: Float32Array, width: number): void {
  for (let i = 0; i < left.length; i += 1) {
    const mid = (left[i] + right[i]) * 0.5;
    const side = (left[i] - right[i]) * 0.5 * width;
    left[i] = mid + side;
    right[i] = mid - side;
  }
}

/** Symmetric tanh drive with a dry/wet mix (adds even-order-free warmth). */
export function saturate(left: Float32Array, right: Float32Array, drive: number, mix: number): void {
  const norm = Math.tanh(drive);
  for (let i = 0; i < left.length; i += 1) {
    const sl = Math.tanh(left[i] * drive) / norm;
    const sr = Math.tanh(right[i] * drive) / norm;
    left[i] = left[i] * (1 - mix) + sl * mix;
    right[i] = right[i] * (1 - mix) + sr * mix;
  }
}

export function applyGainInPlace(left: Float32Array, right: Float32Array, gain: number): void {
  for (let i = 0; i < left.length; i += 1) {
    left[i] *= gain;
    right[i] *= gain;
  }
}

/**
 * ISP look-ahead limiter.
 * The peak envelope is 4x-oversampled (inter-sample peaks included); a
 * monotonic deque returns the max over the 6 ms lookahead window in O(1)
 * amortized; gain is fast-attack / one-pole-release, exactly like the
 * reference tool — but on a true peak envelope.
 */
export async function ispLimit(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  ceilingDb: number,
  lookaheadMs: number,
  releaseMs: number,
  onProgress?: (fraction: number) => void
): Promise<{ avgReductionDb: number }> {
  const ceiling = dbToLin(ceilingDb);
  const lookAhead = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000));
  const releaseCoef = Math.exp(-1 / (sampleRate * (releaseMs / 1000)));

  const env = await computeIspEnvelope(left, right, (f) => onProgress?.(f * 0.4));
  const n = left.length;
  const deque = new Int32Array(n + lookAhead + 16);
  let head = 0;
  let tail = 0;

  const pushIndex = (idx: number) => {
    while (tail > head && env[deque[tail - 1]] <= env[idx]) tail -= 1;
    deque[tail] = idx;
    tail += 1;
  };
  for (let j = 0; j < Math.min(n + lookAhead, env.length); j += 1) pushIndex(j);

  let gain = 1;
  let totalReduction = 0;
  let reductionSamples = 0;
  const chunk = 2_000_000;
  for (let base = 0; base < n; base += chunk) {
    const end = Math.min(n, base + chunk);
    for (let i = base; i < end; i += 1) {
      const add = i + lookAhead;
      if (add < env.length) pushIndex(add);
      while (tail > head && deque[head] < i) head += 1;
      const futurePeak = env[deque[head]] || 0;
      const target = futurePeak > ceiling ? ceiling / futurePeak : 1;
      gain = target < gain ? target : releaseCoef * gain + (1 - releaseCoef) * target;
      left[i] *= gain;
      right[i] *= gain;
      if (gain < 0.999) {
        totalReduction += -linToDb(gain);
        reductionSamples += 1;
      }
    }
    if (onProgress) onProgress(0.4 + (end / n) * 0.6);
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { avgReductionDb: reductionSamples ? totalReduction / reductionSamples : 0 };
}

// ---------------------------------------------------------------------------
// The pipeline itself
// ---------------------------------------------------------------------------

export interface PipelineResult {
  left: Float32Array;
  right: Float32Array;
  /** Measured metrics of the original input. */
  input: PipelineMetrics;
  /** Measured metrics of the mastered output. */
  output: PipelineMetrics;
  /** Max average gain reduction across compressor/limiter, dB. */
  gainReductionDb: number;
  /** Resolved target loudness/ceiling actually applied. */
  appliedTargetLufs: number;
  appliedCeilingDb: number;
  params: ChosenParams;
  findings: PipelineFinding[];
  renderMs: number;
}

export interface RunMasteringOptions {
  left: Float32Array;
  right: Float32Array | null; // null → mono (duplicated to stereo)
  sampleRate: number;
  settings: PipelineSettings;
  /**
   * Optional reference-track metrics: when set, the auto-EQ tone targets are
   * taken from the reference instead of the absolute profile thresholds
   * (reference matching). Without it the behavior is unchanged.
   */
  refMetrics?: PipelineMetrics;
  /** 0..100 progress with an i18n-able stage key. */
  onProgress?: (pct: number, stageKey: string) => void;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Runs the full Smart Master pipeline on a copy of the input (the original
 * arrays are never mutated). Chunked-async: every heavy pass yields to the
 * event loop, so the UI stays responsive on 15-minute files.
 */
export async function runMasteringPipeline(opts: RunMasteringOptions): Promise<PipelineResult> {
  const t0 = performance.now();
  const sr = opts.sampleRate;
  const onProgress = opts.onProgress ?? (() => undefined);

  const left = new Float32Array(opts.left);
  const right = opts.right && opts.right.length === opts.left.length
    ? new Float32Array(opts.right)
    : new Float32Array(opts.left);

  // 1. Analyze input ---------------------------------------------------------
  onProgress(2, 'stageAnalyze');
  const input = await measureMetrics(left, right, sr, (stage, f) => {
    const base = stage === 'loudness' ? 2 : stage === 'truepeak' ? 7 : 11;
    onProgress(base + f * (stage === 'loudness' ? 5 : stage === 'truepeak' ? 4 : 2), 'stageAnalyze');
  });

  const params = chooseParams(input, opts.settings, opts.refMetrics);
  const findings = buildFindings(input, params);

  // 2. DC removal + subsonic HPF + auto-EQ -----------------------------------
  onProgress(14, 'stageDcEq');
  removeDcInPlace(left, right);
  const hpf = biquadCoeffs('highpass', sr, 26, 0.707, 0);
  applyBiquad(left, hpf);
  applyBiquad(right, hpf);
  await tick();

  const eqStages: Array<[BiquadType, number, number, number]> = [
    ['lowshelf', 95, 0.707, params.lowShelfDb],
    ['peaking', 285, 0.9, params.lowMidDb],
    ['peaking', params.harshFreq, 1.25, params.harshDb],
    ['highshelf', 9200, 0.707, params.highShelfDb],
  ];
  for (const [type, freq, q, db] of eqStages) {
    if (Math.abs(db) < 0.01) continue; // skip no-op filters
    const c = biquadCoeffs(type, sr, freq, q, db);
    applyBiquad(left, c);
    applyBiquad(right, c);
    await tick();
  }

  // 3. Bus compression (+ de-ess when the harsh band is hot) -----------------
  onProgress(30, 'stageCompressor');
  const compStats = compressStereo(left, right, sr, params);
  if (params.deEssDb < -0.2) {
    const deEss = biquadCoeffs('peaking', sr, 6500, 1.8, params.deEssDb);
    applyBiquad(left, deEss);
    applyBiquad(right, deEss);
  }
  await tick();

  // 4. Width, texture, anti-alias --------------------------------------------
  onProgress(42, 'stageTexture');
  adjustStereoWidth(left, right, params.width);
  saturate(left, right, params.drive, params.saturationMix);
  const lpf = biquadCoeffs('lowpass', sr, 19000, 0.707, 0);
  applyBiquad(left, lpf);
  applyBiquad(right, lpf);
  await tick();

  // 5. Two-pass loudness normalization with verification ----------------------
  onProgress(52, 'stageLoudness');
  // Only the integrated loudness is needed to pick the makeup gain —
  // measure it directly instead of a full measureMetrics (skips the 4x
  // true-peak pass, which is the most expensive step on long files).
  const preLimit = await measureLoudnessLra(left, right, sr, (f) => onProgress(52 + f * 10, 'stageLoudness'));
  const gainDb = clamp(params.targetLufs - preLimit.integratedLufs, -8, 9);
  applyGainInPlace(left, right, dbToLin(gainDb));
  await tick();

  onProgress(64, 'stageLimiter');
  const limiterStats = await ispLimit(
    left, right, sr,
    params.ceilingDb, params.limiterLookaheadMs, params.limiterReleaseMs,
    (f) => onProgress(64 + f * 20, 'stageLimiter')
  );

  onProgress(86, 'stageVerify');
  let output = await measureMetrics(left, right, sr, (_s, f) => onProgress(86 + f * 6, 'stageVerify'));

  // Safety trim if the ceiling was still breached (should be rare with ISP env).
  if (output.truePeakDb > params.ceilingDb - 0.02) {
    const trimDb = params.ceilingDb - 0.05 - output.truePeakDb;
    applyGainInPlace(left, right, dbToLin(trimDb));
    // eslint-disable-next-line no-await-in-loop
    output = await measureMetrics(left, right, sr, (_s, f) => onProgress(92 + f * 4, 'stageVerify'));
  }

  // Fine gain: if we have headroom and the loudness is still off, nudge and re-limit.
  const delta = params.targetLufs - output.integratedLufs;
  if (Math.abs(delta) > 0.25 && output.truePeakDb < params.ceilingDb - 0.35) {
    applyGainInPlace(left, right, dbToLin(clamp(delta, -1.2, 1.2)));
    // eslint-disable-next-line no-await-in-loop
    await ispLimit(left, right, sr, params.ceilingDb, params.limiterLookaheadMs, params.limiterReleaseMs);
    // eslint-disable-next-line no-await-in-loop
    output = await measureMetrics(left, right, sr, (_s, f) => onProgress(96 + f * 3, 'stageVerify'));
  }

  onProgress(100, 'stageDone');

  return {
    left,
    right,
    input,
    output,
    gainReductionDb: Math.max(compStats.avgReductionDb, limiterStats.avgReductionDb),
    appliedTargetLufs: params.targetLufs,
    appliedCeilingDb: params.ceilingDb,
    params,
    findings,
    renderMs: performance.now() - t0,
  };
}
