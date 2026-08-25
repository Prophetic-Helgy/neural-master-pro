/**
 * audioMeters.ts — precise audio measurement core (pure TypeScript, zero dependencies).
 *
 * Implements EBU R128 / ITU-R BS.1770-4 measurements:
 *  - Integrated loudness (K-weighting, dual gating: absolute -70 LU, relative -10 LU)
 *  - True peak via 4x oversampling (32-tap windowed-sinc FIR, polyphase — ebur128-style)
 *  - LRA (BS.1770-4: 3s/40% windows, I-weighting, M-weighting, 5/95 percentiles, +10 LU cap)
 *  - FFT-based tone analysis (2048 / Hann, ~72 frames) for auto-mastering decisions
 *  - Streaming momentary loudness meter for the live UI panel
 *
 * The module is browser-free on purpose: it runs in Node (scripts/test-audio.ts)
 * and in the Electron renderer / Vite bundle. Only erasable TS syntax is used
 * so the file also works with Node's native type stripping.
 */

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const dbToLin = (db: number): number => Math.pow(10, db / 20);
export const linToDb = (value: number): number => 20 * Math.log10(Math.max(value, 1e-12));

/** "Effectively silent" floor used whenever a log10 of zero would be a problem. */
export const SILENCE_DB = -120;

// BS.1770 / ebur128 normalization: M = -0.691 + 10*log10(mean Z),
// Z = sum over channels of (K-weighted sample)^2 (L/R weights = 1).
const LU_OFFSET = -0.691;
const ABS_GATE_LU = -70.0;
const REL_GATE_LU = -10.0;

// ---------------------------------------------------------------------------
// RBJ biquads (same formulas the reference mastering tool uses)
// ---------------------------------------------------------------------------

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export type BiquadType = 'lowpass' | 'highpass' | 'peaking' | 'lowshelf' | 'highshelf';

export function biquadCoeffs(
  type: BiquadType,
  sampleRate: number,
  frequency: number,
  q = 0.707,
  gainDb = 0
): BiquadCoeffs {
  const safeFrequency = clamp(frequency, 10, Math.max(20, sampleRate * 0.45));
  const safeQ = Math.max(0.1, q);
  const w0 = (2 * Math.PI * safeFrequency) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * safeQ);
  const a = Math.pow(10, gainDb / 40);

  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (type === 'peaking') {
    b0 = 1 + alpha * a;
    b1 = -2 * cos;
    b2 = 1 - alpha * a;
    a0 = 1 + alpha / a;
    a1 = -2 * cos;
    a2 = 1 - alpha / a;
  } else if (type === 'lowshelf') {
    const sqrtA = Math.sqrt(a);
    const shelfAlpha = (sin / 2) * Math.SQRT2;
    b0 = a * (a + 1 - (a - 1) * cos + 2 * sqrtA * shelfAlpha);
    b1 = 2 * a * (a - 1 - (a + 1) * cos);
    b2 = a * (a + 1 - (a - 1) * cos - 2 * sqrtA * shelfAlpha);
    a0 = a + 1 + (a - 1) * cos + 2 * sqrtA * shelfAlpha;
    a1 = -2 * (a - 1 + (a + 1) * cos);
    a2 = a + 1 + (a - 1) * cos - 2 * sqrtA * shelfAlpha;
  } else {
    const sqrtA = Math.sqrt(a);
    const shelfAlpha = (sin / 2) * Math.SQRT2;
    b0 = a * (a + 1 + (a - 1) * cos + 2 * sqrtA * shelfAlpha);
    b1 = -2 * a * (a - 1 + (a + 1) * cos);
    b2 = a * (a + 1 + (a - 1) * cos - 2 * sqrtA * shelfAlpha);
    a0 = a + 1 - (a - 1) * cos + 2 * sqrtA * shelfAlpha;
    a1 = 2 * (a - 1 - (a + 1) * cos);
    a2 = a + 1 - (a - 1) * cos - 2 * sqrtA * shelfAlpha;
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Direct-form II biquad with persistent state (can be stepped sample-by-sample
 * across arbitrarily long buffers or across chunk boundaries).
 */
export class BiquadState {
  private c: BiquadCoeffs;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(c: BiquadCoeffs) {
    this.c = c;
  }

  step(x: number): number {
    const y = this.c.b0 * x + this.c.b1 * this.x1 + this.c.b2 * this.x2 - this.c.a1 * this.y1 - this.c.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
}

/** Apply a biquad to a whole buffer in place (or into `out` when provided). */
export function applyBiquad(data: Float32Array, c: BiquadCoeffs, out?: Float32Array): Float32Array {
  const dst = out && out.length >= data.length ? out : data;
  const st = new BiquadState(c);
  for (let i = 0; i < data.length; i += 1) {
    dst[i] = st.step(data[i]);
  }
  return dst;
}

/**
 * BS.1770-4 K-weighting: high-shelf pre-filter + DC-removal high-pass
 * (2 cascaded biquads per channel). Exact ITU table coefficients for 48 kHz,
 * bilinear retuning from the spec's analog prototype for other rates.
 */
export function kWeightingCoeffs(sampleRate: number): { stage1: BiquadCoeffs; stage2: BiquadCoeffs } {
  let s1: BiquadCoeffs;
  if (sampleRate === 48000) {
    // ITU-R BS.1770-4 Table 1 (48 kHz)
    s1 = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
  } else {
    // High-shelf analog prototype: fc = 1681.974450955533 Hz, G = +3.999 dB, Q = 0.7071752369554196
    const fs = sampleRate;
    const K = Math.tan((Math.PI * 1681.974450955533) / fs);
    const VH = Math.pow(10, 3.999 / 20);
    const Vb = Math.pow(VH, 0.4996667741545416);
    const Q = 0.7071752369554196;
    const denom = 1 + K / Q + K * K;
    s1 = {
      b0: (VH + Vb * K / Q + K * K) / denom,
      b1: 2 * (K * K - VH) / denom,
      b2: (VH - Vb * K / Q + K * K) / denom,
      a1: 2 * (K * K - 1) / denom,
      a2: (1 - K / Q + K * K) / denom,
    };
  }

  let s2: BiquadCoeffs;
  if (sampleRate === 48000) {
    // ITU-R BS.1770-4 Table 2 (48 kHz)
    s2 = { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 };
  } else {
    const fs = sampleRate;
    const K = Math.tan((Math.PI * 38.1379618071668) / fs);
    const Q = 0.5003270373238773;
    const denom = 1 + K / Q + K * K;
    s2 = {
      b0: 1 / denom,
      b1: -2 / denom,
      b2: 1 / denom,
      a1: 2 * (K * K - 1) / denom,
      a2: (1 - K / Q + K * K) / denom,
    };
  }

  return { stage1: s1, stage2: s2 };
}

/** BS.1770-4 M-weighting for LRA: high-shelf, 15 kHz, Q 0.707, +1.5 dB. */
export function mWeightingCoeffs(sampleRate: number): BiquadCoeffs {
  return biquadCoeffs('highshelf', sampleRate, 15000, 0.707, 1.5);
}

// ---------------------------------------------------------------------------
// Integrated loudness + LRA (single streaming pass, O(window) memory)
// ---------------------------------------------------------------------------

interface LoudnessState {
  sr: number;
  // K-weighting + M-weighting filter states (per channel)
  k1L: BiquadState; k2L: BiquadState;
  k1R: BiquadState; k2R: BiquadState;
  mL: BiquadState; mR: BiquadState;
  // Integrated: 400 ms window / 100 ms hop
  intWin: number;
  intHop: number;
  intRing: Float64Array;
  intPos: number;
  intSum: number;
  intCount: number;
  intWins: number[]; // Z sums per 400 ms window
  // LRA: 3 s window / 1.8 s hop (40% overlap), K- and M-weighted
  lraWin: number;
  lraHop: number;
  lraRingK: Float64Array;
  lraRingM: Float64Array;
  lraPos: number;
  lraSumK: number;
  lraSumM: number;
  lraCount: number;
  lraWinsK: number[];
  lraWinsM: number[];
}

function createLoudnessState(sr: number): LoudnessState {
  const kw = kWeightingCoeffs(sr);
  const mw = mWeightingCoeffs(sr);
  const intWin = Math.max(1, Math.round(0.4 * sr));
  const lraWin = Math.max(1, Math.round(3 * sr));
  return {
    sr,
    k1L: new BiquadState(kw.stage1), k2L: new BiquadState(kw.stage2),
    k1R: new BiquadState(kw.stage1), k2R: new BiquadState(kw.stage2),
    mL: new BiquadState(mw), mR: new BiquadState(mw),
    intWin,
    intHop: Math.max(1, Math.round(0.1 * sr)),
    intRing: new Float64Array(intWin),
    intPos: 0,
    intSum: 0,
    intCount: 0,
    intWins: [],
    lraWin,
    lraHop: Math.max(1, Math.round(1.8 * sr)),
    lraRingK: new Float64Array(lraWin),
    lraRingM: new Float64Array(lraWin),
    lraPos: 0,
    lraSumK: 0,
    lraSumM: 0,
    lraCount: 0,
    lraWinsK: [],
    lraWinsM: [],
  };
}

/** Advance the streaming loudness state over [start, end). */
function loudnessProcessRange(st: LoudnessState, left: Float32Array, right: Float32Array, start: number, end: number): void {
  for (let i = start; i < end; i += 1) {
    const l = left[i];
    const r = right[i];
    const kl = st.k2L.step(st.k1L.step(l));
    const kr = st.k2R.step(st.k1R.step(r));
    const zk = kl * kl + kr * kr;
    const ml = st.mL.step(l);
    const mr = st.mR.step(r);
    const zm = ml * ml + mr * mr;

    // Integrated window (400 ms / 100 ms hop)
    st.intSum += zk - st.intRing[st.intPos];
    st.intRing[st.intPos] = zk;
    st.intPos = (st.intPos + 1) % st.intWin;
    st.intCount += 1;
    if (st.intCount >= st.intWin && (st.intCount - st.intWin) % st.intHop === 0) {
      st.intWins.push(st.intSum);
    }

    // LRA windows (3 s / 1.8 s hop)
    st.lraSumK += zk - st.lraRingK[st.lraPos];
    st.lraRingK[st.lraPos] = zk;
    st.lraSumM += zm - st.lraRingM[st.lraPos];
    st.lraRingM[st.lraPos] = zm;
    st.lraPos = (st.lraPos + 1) % st.lraWin;
    st.lraCount += 1;
    if (st.lraCount >= st.lraWin && (st.lraCount - st.lraWin) % st.lraHop === 0) {
      st.lraWinsK.push(st.lraSumK);
      st.lraWinsM.push(st.lraSumM);
    }
  }
}

function windowLufs(sumZ: number, winSamples: number): number {
  return LU_OFFSET + 10 * Math.log10(Math.max(sumZ / winSamples, 1e-12));
}

/** BS.1770 dual-gated integrated loudness from the accumulated 400 ms window sums. */
export function finalizeIntegratedLufs(st: LoudnessState): number {
  const wins = st.intWins;
  if (wins.length === 0) return SILENCE_DB;

  const lufs: number[] = wins.map((z) => windowLufs(z, st.intWin));
  // Absolute gate
  const absPass = lufs.map((lu, i) => lu > ABS_GATE_LU ? i : -1).filter((i) => i >= 0);
  if (absPass.length === 0) return SILENCE_DB;

  // Relative gate = integrated loudness of abs-passing audio - 10 LU
  let zPass = 0;
  let nPass = 0;
  for (const i of absPass) {
    zPass += wins[i];
    nPass += st.intWin;
  }
  const relGate = LU_OFFSET + 10 * Math.log10(Math.max(zPass / nPass, 1e-12)) + REL_GATE_LU;

  let zFinal = 0;
  let nFinal = 0;
  for (const i of absPass) {
    if (lufs[i] > relGate) {
      zFinal += wins[i];
      nFinal += st.intWin;
    }
  }
  if (nFinal === 0) return SILENCE_DB;
  return LU_OFFSET + 10 * Math.log10(zFinal / nFinal);
}

/**
 * Weighted percentile (linear interpolation) over I-weighted M-weighted window
 * loudness — the BS.1770-4 LRA percentile computation.
 */
function weightedPercentile(values: number[], weights: number[], p: number): number | null {
  const pairs: Array<{ v: number; w: number }> = [];
  for (let i = 0; i < values.length; i += 1) {
    if (weights[i] > 0) pairs.push({ v: values[i], w: weights[i] });
  }
  if (pairs.length === 0) return null;
  pairs.sort((a, b) => a.v - b.v);
  let total = 0;
  for (const pair of pairs) total += pair.w;
  if (total <= 0) return null;

  const target = p * total;
  let acc = 0;
  for (let i = 0; i < pairs.length; i += 1) {
    const before = acc;
    acc += pairs[i].w;
    if (acc >= target) {
      const within = target - before;
      if (pairs[i].w <= within + 1e-12 || i === pairs.length - 1) return pairs[i].v;
      const next = pairs[i + 1];
      const frac = within / pairs[i].w;
      return pairs[i].v + (next.v - pairs[i].v) * Math.min(1, frac);
    }
  }
  return pairs[pairs.length - 1].v;
}

/** BS.1770-4 LRA: 3 s/40% windows, I-weighting, M-weighting, 5/95 percentiles, capped at 10 LU. */
export function finalizeLra(st: LoudnessState): number {
  const n = st.lraWinsK.length;
  if (n < 2) return 0;

  const lufsK: number[] = new Array(n);
  const lufsM: number[] = new Array(n);
  let maxK = -Infinity;
  for (let i = 0; i < n; i += 1) {
    lufsK[i] = windowLufs(st.lraWinsK[i], st.lraWin);
    lufsM[i] = windowLufs(st.lraWinsM[i], st.lraWin);
    if (lufsK[i] > maxK) maxK = lufsK[i];
  }

  // Absolute gate + I-weighting
  const weights: number[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    weights[i] = lufsK[i] > ABS_GATE_LU ? Math.pow(10, (lufsK[i] - maxK) / 10) : 0;
  }

  const p05 = weightedPercentile(lufsM, weights, 0.05);
  const p95 = weightedPercentile(lufsM, weights, 0.95);
  if (p05 === null || p95 === null) return 0;
  return clamp(p95 - p05, 0, 10);
}

/**
 * Streaming driver: chunked so long buffers never freeze the UI.
 * Returns integrated loudness + LRA in one combined pass.
 */
export async function measureLoudnessLra(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void
): Promise<{ integratedLufs: number; lra: number }> {
  const st = createLoudnessState(sampleRate);
  const n = left.length;
  const chunk = 4_000_000;
  for (let start = 0; start < n; start += chunk) {
    const end = Math.min(n, start + chunk);
    loudnessProcessRange(st, left, right, start, end);
    if (onProgress && start + chunk < n) onProgress(end / n);
    // Yield to the event loop between chunks so the UI stays responsive.
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { integratedLufs: finalizeIntegratedLufs(st), lra: finalizeLra(st) };
}

// ---------------------------------------------------------------------------
// True peak — 4x oversampling (ITU-R BS.1770-4 / ebur128 reference approach)
// ---------------------------------------------------------------------------

/**
 * Prototype low-pass for 4x upsampling: 256 taps, Blackman–Harris windowed
 * sinc, cutoff at the original Nyquist (pi/4 in the 4x domain, 24 kHz @ 48k),
 * DC-normalized (taps sum to 1). Passband is flat to ~22 kHz (±0.02 dB) and
 * the inter-sample images (48 kHz ± f) are suppressed by > 90 dB, so a
 * band-limited tone reconstructs at its true continuous amplitude.
 * Decomposed into 4 polyphase branches of 64 taps.
 *
 * The previous 32-tap Hamming design had two defects (exposed by T3):
 * 20 kHz sat in the middle of the transition band (−1.8 dB droop) and the
 * 28 kHz image of a 20 kHz tone leaked through, so the measured peak
 * wobbled with tone phase (±0.5 dB).
 */
const TP4X_TAPS = 256;
const TP4X_BRANCH = TP4X_TAPS / 4;
let tp4xPhases: Float64Array[] | null = null;

function tp4xCoeffs(): Float64Array[] {
  if (tp4xPhases) return tp4xPhases;
  const L = TP4X_TAPS;
  const center = (L - 1) / 2;
  const a0 = 0.35875;
  const a1 = 0.48829;
  const a2 = 0.14128;
  const a3 = 0.01168;
  const h = new Float64Array(L);
  for (let nIdx = 0; nIdx < L; nIdx += 1) {
    const m = nIdx - center;
    const ideal = m === 0 ? 1 : Math.sin((Math.PI / 4) * m) / (Math.PI * m);
    const bh =
      a0 -
      a1 * Math.cos((2 * Math.PI * nIdx) / (L - 1)) +
      a2 * Math.cos((4 * Math.PI * nIdx) / (L - 1)) -
      a3 * Math.cos((6 * Math.PI * nIdx) / (L - 1));
    h[nIdx] = ideal * bh;
  }
  // DC-normalize: the windowed-sinc prototype's tap sum is not 1 for this
  // window/length; unity DC gain keeps the interpolator exact on DC.
  let sum = 0;
  for (let nIdx = 0; nIdx < L; nIdx += 1) sum += h[nIdx];
  for (let nIdx = 0; nIdx < L; nIdx += 1) h[nIdx] /= sum;
  // x4: upsampling by 4 attenuates each polyphase branch by 4x; the
  // interpolator must restore unity gain (y[4j+m] = 4 * sum_d x[j-d] h[4d+m]).
  const phases: Float64Array[] = [];
  for (let m = 0; m < 4; m += 1) {
    const f = new Float64Array(TP4X_BRANCH);
    for (let d = 0; d < TP4X_BRANCH; d += 1) f[d] = h[4 * d + m] * 4;
    phases.push(f);
  }
  tp4xPhases = phases;
  return phases;
}

/**
 * 4x-oversampled true peak in dBTP. `right === null` for mono.
 * Runs in chunks with an optional progress callback (0..1).
 */
export async function measureTruePeak4x(
  left: Float32Array,
  right: Float32Array | null,
  onProgress?: (fraction: number) => void
): Promise<number> {
  const phases = tp4xCoeffs();
  const n = left.length;
  const len = n + TP4X_BRANCH; // tail frames (zero-padded input), full flush
  let maxAbs = 0;

  for (let m = 0; m < 4; m += 1) {
    const f = phases[m];
    let done = 0;
    for (let base = 0; base < len; base += 2_000_000) {
      const end = Math.min(len, base + 2_000_000);
      for (let j = base; j < end; j += 1) {
        // Clamp the tap range per j so the inner loop stays branchless:
        // d ≤ j (no negative index) and, in the zero-padded tail,
        // d ≥ j - n + 1 (no index past the input).
        const dMin = j >= n ? j - n + 1 : 0;
        const dMax = Math.min(TP4X_BRANCH, j + 1);
        let yl = 0;
        for (let d = dMin; d < dMax; d += 1) yl += left[j - d] * f[d];
        if (yl > maxAbs) maxAbs = yl;
        else if (yl < -maxAbs) maxAbs = -yl;
        if (right) {
          let yr = 0;
          for (let d = dMin; d < dMax; d += 1) yr += right[j - d] * f[d];
          if (yr > maxAbs) maxAbs = yr;
          else if (yr < -maxAbs) maxAbs = -yr;
        }
      }
      done = end;
      if (onProgress) onProgress((m + done / len) / 4);
      // Yield between chunks.
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return maxAbs > 0 ? 20 * Math.log10(maxAbs) : SILENCE_DB;
}

/**
 * ISP envelope for the look-ahead limiter: env4[j] = max |y[4j..4j+3]| over
 * both channels, i.e. the highest 4x-oversampled value inside base interval j.
 * One full polyphase pass, O(n) memory, chunked so long buffers stay responsive.
 */
export async function computeIspEnvelope(
  left: Float32Array,
  right: Float32Array | null,
  onProgress?: (fraction: number) => void
): Promise<Float32Array> {
  const phases = tp4xCoeffs();
  const n = left.length;
  const len = n + TP4X_BRANCH;
  const env = new Float32Array(len);
  const chunk = 2_000_000;
  for (let m = 0; m < 4; m += 1) {
    const f = phases[m];
    for (let base = 0; base < len; base += chunk) {
      const end = Math.min(len, base + chunk);
      for (let j = base; j < end; j += 1) {
        const dMin = j >= n ? j - n + 1 : 0;
        const dMax = Math.min(TP4X_BRANCH, j + 1);
        let yl = 0;
        for (let d = dMin; d < dMax; d += 1) yl += left[j - d] * f[d];
        let peak = yl > 0 ? yl : -yl;
        if (right) {
          let yr = 0;
          for (let d = dMin; d < dMax; d += 1) yr += right[j - d] * f[d];
          const pr = yr > 0 ? yr : -yr;
          if (pr > peak) peak = pr;
        }
        if (peak > env[j]) env[j] = peak;
      }
      if (onProgress) onProgress((m * len + end) / (4 * len));
      // Yield between chunks.
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Simple level measurements
// ---------------------------------------------------------------------------

export function measureSamplePeak(left: Float32Array, right: Float32Array | null): number {
  let peak = 0;
  for (let i = 0; i < left.length; i += 1) {
    const v = Math.abs(left[i]);
    if (v > peak) peak = v;
    if (right) {
      const vr = Math.abs(right[i]);
      if (vr > peak) peak = vr;
    }
  }
  return peak;
}

/** RMS of the mono sum (L+R)/2 — same definition as loudness power normalization. */
export function measureRms(left: Float32Array, right: Float32Array | null): number {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    const r = right ? right[i] : left[i];
    sum += (left[i] * left[i] + r * r) * 0.5;
  }
  return Math.sqrt(sum / Math.max(1, left.length));
}

/** DC offset (mean value) per channel, in linear scale. */
export function measureDcOffset(left: Float32Array, right: Float32Array | null): { l: number; r: number } {
  let sumL = 0;
  let sumR = 0;
  const n = left.length;
  for (let i = 0; i < n; i += 1) {
    sumL += left[i];
    sumR += right ? right[i] : left[i];
  }
  return { l: sumL / Math.max(1, n), r: sumR / Math.max(1, n) };
}

/**
 * Max |DC| across channels in dBFS, floored at -240 dB. Uses |dc| so a
 * near-zero offset (sign decided by float rounding) reads as silence
 * instead of ±240 dB.
 */
export function dcOffsetDb(dc: { l: number; r: number }): number {
  return Math.max(
    20 * Math.log10(Math.max(Math.abs(dc.l), 1e-12)),
    20 * Math.log10(Math.max(Math.abs(dc.r), 1e-12))
  );
}

/** Subtract the mean from each channel in place; returns the removed offsets. */
export function removeDcInPlace(left: Float32Array, right: Float32Array | null): { l: number; r: number } {
  const dc = measureDcOffset(left, right);
  for (let i = 0; i < left.length; i += 1) {
    left[i] -= dc.l;
    if (right) right[i] -= dc.r;
  }
  return dc;
}

/** Stereo cross-correlation, decimated for long buffers (competitor-compatible). */
export function measureCorrelation(left: Float32Array, right: Float32Array | null): number {
  if (!right || right.length !== left.length) return 1;
  let lr = 0;
  let ll = 0;
  let rr = 0;
  const step = Math.max(1, Math.floor(left.length / 180_000));
  for (let i = 0; i < left.length; i += step) {
    lr += left[i] * right[i];
    ll += left[i] * left[i];
    rr += right[i] * right[i];
  }
  const denom = Math.sqrt(Math.max(ll * rr, 1e-12));
  return denom > 0 ? lr / denom : 0;
}

// ---------------------------------------------------------------------------
// Tone analysis — FFT 2048 / Hann, ~72 frames (same scheme as the reference tool)
// ---------------------------------------------------------------------------

/** In-place iterative radix-2 FFT (power of two). */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i += 1) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wR = Math.cos(ang);
    const wI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k;
        const b = i + k + len / 2;
        const tR = re[b] * curR - im[b] * curI;
        const tI = re[b] * curI + im[b] * curR;
        re[b] = re[a] - tR;
        im[b] = im[a] - tI;
        re[a] += tR;
        im[a] += tI;
        const nR = curR * wR - curI * wI;
        curI = curR * wI + curI * wR;
        curR = nR;
      }
    }
  }
}

export interface ToneAnalysis {
  /** Energy fractions of the full spectrum (reference-tool band map). */
  subRatio: number;
  bassRatio: number;
  lowMidRatio: number;
  midRatio: number;
  harshRatio: number;
  highRatio: number;
  airRatio: number;
  /** Average spectral centroid, Hz. */
  centroid: number;
  /** Dominant frequency in the 2-5 kHz harsh band (EMA across frames). */
  harshPeakHz: number;
  /** Stereo correlation of the source. */
  correlation: number;
  /** 0..1, derived from correlation. */
  widthScore: number;
  /**
   * Panel band levels normalized to 0..1 (loudest band = 1) for the
   * DiagnosticPanel bar display: sub 20-60, low 60-250, lowMid 250-500,
   * mid 500-2k, highMid 2-6k, high 6k-20k.
   */
  panel: { sub: number; low: number; lowMid: number; mid: number; highMid: number; high: number };
}

export function analyzeTone(left: Float32Array, right: Float32Array | null, sampleRate: number): ToneAnalysis {
  const fftSize = 2048;
  const empty: ToneAnalysis = {
    subRatio: 0, bassRatio: 0, lowMidRatio: 0, midRatio: 0, harshRatio: 0, highRatio: 0, airRatio: 0,
    centroid: 0, harshPeakHz: 3400, correlation: 0, widthScore: 0,
    panel: { sub: 0, low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 },
  };

  // Band accumulators: reference-tool map + DiagnosticPanel map
  const algo = { sub: 0, bass: 0, lowMid: 0, mid: 0, harsh: 0, high: 0, air: 0, full: 0 };
  const panel = { sub: 0, low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 };
  let centroidSum = 0;
  let frames = 0;
  let harshPeakHz = 3400;

  if (left.length >= fftSize * 2) {
    const hop = Math.max(fftSize, Math.floor(left.length / 72));
    const window = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i += 1) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);

    for (let start = 0; start + fftSize < left.length; start += hop) {
      for (let i = 0; i < fftSize; i += 1) {
        const r = right ? right[start + i] : left[start + i];
        re[i] = (left[start + i] + r) * 0.5 * window[i];
        im[i] = 0;
      }
      fftInPlace(re, im);

      let frameEnergy = 0;
      let frameCentroid = 0;
      let localHarsh = 0;
      let localHarshHz = harshPeakHz;

      for (let bin = 1; bin < fftSize / 2; bin += 1) {
        const hz = (bin * sampleRate) / fftSize;
        const mag2 = re[bin] * re[bin] + im[bin] * im[bin];
        frameEnergy += mag2;
        frameCentroid += hz * mag2;
        algo.full += mag2;

        // Reference-tool band map (drives the auto-EQ decisions)
        if (hz < 60) algo.sub += mag2;
        else if (hz < 180) algo.bass += mag2;
        else if (hz < 450) algo.lowMid += mag2;
        else if (hz < 2000) algo.mid += mag2;
        else if (hz < 5000) {
          algo.harsh += mag2;
          if (mag2 > localHarsh) {
            localHarsh = mag2;
            localHarshHz = hz;
          }
        } else if (hz < 12000) algo.high += mag2;
        else algo.air += mag2;

        // DiagnosticPanel band map
        if (hz < 60) panel.sub += mag2;
        else if (hz < 250) panel.low += mag2;
        else if (hz < 500) panel.lowMid += mag2;
        else if (hz < 2000) panel.mid += mag2;
        else if (hz < 6000) panel.highMid += mag2;
        else if (hz < 20000) panel.high += mag2;
      }
      if (frameEnergy > 0) {
        centroidSum += frameCentroid / frameEnergy;
        harshPeakHz = (harshPeakHz * frames + localHarshHz) / (frames + 1);
        frames += 1;
      }
    }
  }

  const full = Math.max(algo.full, 1e-12);
  const maxPanel = Math.max(panel.sub, panel.low, panel.lowMid, panel.mid, panel.highMid, panel.high, 1e-12);
  const correlation = right && right.length === left.length ? measureCorrelation(left, right) : 1;

  return {
    subRatio: algo.sub / full,
    bassRatio: algo.bass / full,
    lowMidRatio: algo.lowMid / full,
    midRatio: algo.mid / full,
    harshRatio: algo.harsh / full,
    highRatio: algo.high / full,
    airRatio: algo.air / full,
    centroid: frames ? centroidSum / frames : 0,
    harshPeakHz,
    correlation,
    widthScore: Math.sqrt(Math.max(0, 1 - correlation)),
    panel: {
      sub: panel.sub / maxPanel,
      low: panel.low / maxPanel,
      lowMid: panel.lowMid / maxPanel,
      mid: panel.mid / maxPanel,
      highMid: panel.highMid / maxPanel,
      high: panel.high / maxPanel,
    },
  };
}

// ---------------------------------------------------------------------------
// Combined metrics snapshot (input / output of the mastering pipeline)
// ---------------------------------------------------------------------------

export interface PipelineMetrics {
  integratedLufs: number;
  truePeakDb: number;
  samplePeakDb: number;
  lra: number;
  /** Linear crest factor: samplePeak / rms (used by the auto-parameter math). */
  crestFactor: number;
  /** Crest in dB for display. */
  crestDb: number;
  correlation: number;
  /** Max |mean| across channels, dB. */
  dcOffsetDb: number;
  tone: ToneAnalysis;
}

/**
 * Full measurement of a stereo buffer: integrated LUFS + LRA (one K/M pass),
 * true peak (4x), sample peak / RMS / DC / correlation, and tone analysis.
 */
export async function measureMetrics(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
  onProgress?: (stage: 'loudness' | 'truepeak' | 'tone', fraction: number) => void
): Promise<PipelineMetrics> {
  const r = right && right.length === left.length ? right : left;

  const samplePeak = measureSamplePeak(left, r);
  const rms = measureRms(left, r);
  const dc = measureDcOffset(left, r);
  const correlation = right && right.length === left.length ? measureCorrelation(left, r) : 1;

  onProgress?.('loudness', 0);
  const { integratedLufs, lra } = await measureLoudnessLra(left, r, sampleRate, (f) => onProgress?.('loudness', f * 0.5));
  onProgress?.('truepeak', 0);
  const truePeakDb = await measureTruePeak4x(left, right, (f) => onProgress?.('truepeak', f * 0.5));
  onProgress?.('tone', 1);
  const tone = analyzeTone(left, right, sampleRate);

  const crestFactor = samplePeak / Math.max(rms, 1e-9);
  const samplePeakDb = samplePeak > 0 ? 20 * Math.log10(samplePeak) : SILENCE_DB;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : SILENCE_DB;

  return {
    integratedLufs,
    truePeakDb,
    samplePeakDb,
    lra,
    crestFactor,
    crestDb: Math.min(20, samplePeakDb - rmsDb),
    correlation,
    dcOffsetDb: dcOffsetDb(dc),
    tone,
  };
}

// ---------------------------------------------------------------------------
// Streaming momentary loudness meter (live UI panel)
// ---------------------------------------------------------------------------

/**
 * Feed time-domain frames (e.g. AnalyserNode output) and read true
 * BS.1770 streaming loudness (ungated): `momentary` is the 400 ms window,
 * `shortTerm` the 3 s window. No more RMS approximations.
 * Feed sample-accurately (no repeated samples) to keep the K-weighting
 * biquad state correct.
 */
export class LoudnessMeter {
  private k1L: BiquadState;
  private k2L: BiquadState;
  private k1R: BiquadState;
  private k2R: BiquadState;
  private ring: Float64Array;
  private pos = 0;
  private sum = 0;
  private ringS: Float64Array;
  private posS = 0;
  private sumS = 0;
  private count = 0;

  constructor(sampleRate: number) {
    const kw = kWeightingCoeffs(sampleRate);
    this.k1L = new BiquadState(kw.stage1);
    this.k2L = new BiquadState(kw.stage2);
    this.k1R = new BiquadState(kw.stage1);
    this.k2R = new BiquadState(kw.stage2);
    this.ring = new Float64Array(Math.max(1, Math.round(0.4 * sampleRate)));
    this.ringS = new Float64Array(Math.max(1, Math.round(3 * sampleRate)));
  }

  push(left: Float32Array, right: Float32Array): void {
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i += 1) {
      const kl = this.k2L.step(this.k1L.step(left[i]));
      const kr = this.k2R.step(this.k1R.step(right[i]));
      const z = kl * kl + kr * kr;
      this.sum += z - this.ring[this.pos];
      this.ring[this.pos] = z;
      this.pos = (this.pos + 1) % this.ring.length;
      this.sumS += z - this.ringS[this.posS];
      this.ringS[this.posS] = z;
      this.posS = (this.posS + 1) % this.ringS.length;
    }
    this.count += n;
  }

  /** Momentary loudness in LU (400 ms, no gating), or SILENCE_DB until warm. */
  get momentary(): number {
    const len = Math.min(this.count, this.ring.length);
    if (len < 100) return SILENCE_DB;
    return LU_OFFSET + 10 * Math.log10(Math.max(this.sum / len, 1e-12));
  }

  /** Short-term loudness in LU (3 s, no gating), or SILENCE_DB until warm. */
  get shortTerm(): number {
    const len = Math.min(this.count, this.ringS.length);
    if (len < 100) return SILENCE_DB;
    return LU_OFFSET + 10 * Math.log10(Math.max(this.sumS / len, 1e-12));
  }

  reset(): void {
    this.k1L.reset();
    this.k2L.reset();
    this.k1R.reset();
    this.k2R.reset();
    this.ring.fill(0);
    this.pos = 0;
    this.sum = 0;
    this.ringS.fill(0);
    this.posS = 0;
    this.sumS = 0;
    this.count = 0;
  }
}

// ---------------------------------------------------------------------------
// findPeakCuePoints — deterministic "cut at the audio peak" cues for the
// multi-clip video export (Pexels b-roll). The region is split into
// 1-second windows (same grid as the timeline analysis); each window is
// scored by peak amplitude, the strongest windows are picked greedily with
// a refractory gap (minGapSec), and each cue lands on the argmax sample of
// its window — the actual peak, not the window start. No cues inside
// edgeMarginSec of the region edges. Ties break toward the earlier time,
// so the output is deterministic. [] on silence or too-short regions.
// ---------------------------------------------------------------------------

export interface PeakCueOptions {
  /** Window length in seconds (default 1). */
  windowSec?: number;
  /** Minimum distance between adjacent cues in seconds (default 3). */
  minGapSec?: number;
  /** Zone around the region edges that receives no cues, in seconds (default 1). */
  edgeMarginSec?: number;
  /** Hard cap on the number of cues (e.g. the number of selected clips). */
  maxCues?: number;
}

export function findPeakCuePoints(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
  regionStart: number,
  regionEnd: number,
  opts: PeakCueOptions = {}
): number[] {
  const windowSec = opts.windowSec ?? 1;
  const minGapSec = opts.minGapSec ?? 3;
  const edgeMarginSec = opts.edgeMarginSec ?? 1;
  const maxCues = opts.maxCues;
  const sr = Math.max(1, Math.floor(sampleRate));
  const win = Math.max(1, Math.floor(windowSec * sr));
  const len = regionEnd - regionStart;
  if (!left || left.length === 0 || len <= edgeMarginSec * 2) return [];
  const iStart = Math.max(0, Math.floor(regionStart * sr));
  const iEnd = Math.min(left.length, Math.floor(regionEnd * sr));
  const lo = iStart + Math.floor(edgeMarginSec * sr);
  const hi = iEnd - Math.floor(edgeMarginSec * sr);
  if (hi - lo < win) return [];

  // Score every 1-s window: peak amplitude + argmax offset inside it.
  const windows: { t: number; energy: number }[] = [];
  for (let w0 = lo; w0 + win <= hi; w0 += win) {
    let peak = 0;
    let peakOff = 0;
    for (let off = 0; off < win; off += 1) {
      const i = w0 + off;
      const a = Math.abs(left[i]);
      const b = right ? Math.abs(right[i]) : 0;
      const v = a > b ? a : b;
      if (v > peak) { peak = v; peakOff = off; }
    }
    if (peak <= 1e-6) continue; // silent window
    windows.push({ t: (w0 + peakOff) / sr, energy: peak });
  }
  if (windows.length === 0) return [];

  // Greedy: strongest first, ties toward the earlier time.
  windows.sort((a, b) => (b.energy !== a.energy ? b.energy - a.energy : a.t - b.t));
  const picked: number[] = [];
  for (const w of windows) {
    if (maxCues !== undefined && picked.length >= maxCues) break;
    let tooClose = false;
    for (const p of picked) {
      if (Math.abs(p - w.t) < minGapSec) { tooClose = true; break; }
    }
    if (!tooClose) picked.push(w.t);
  }
  picked.sort((a, b) => a - b);
  return picked;
}
