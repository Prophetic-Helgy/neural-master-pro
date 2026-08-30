/**
 * audioAlign.ts — Vocal Align core (VocAlign-style guide/dub alignment).
 *
 * Pure, deterministic, worker-friendly: no DOM, no AudioContext. The engine:
 *  1. RMS envelopes of guide/dub (10 ms hop);
 *  2. onset picking (energy-rise threshold, min spacing);
 *  3. monotonic greedy guide↔dub anchor matching (expected-position
 *     window scaled by maxStretch — no NCC refinement: on sparse onset
 *     envelopes self-similarity of the shifted dub collapses the shift);
 *  4. piecewise-linear time map guide→dub (per-segment rate clamped to
 *     1/maxStretch..maxStretch);
 *  5. WSOLA time-stretch of the dub onto the guide grid (30 ms Hann / 10 ms
 *     hop, ±5 ms continuity search) — preserves pitch;
 *  6. strength blend: out = (1−s)·dry + s·aligned (s = 0 returns the dub
 *     verbatim — "applied" semantics, not a resample).
 *
 * This is envelope/energy alignment, not ML source separation or phoneme
 * warping — matches onsets, keeps formants, bounded by maxStretch.
 */

export interface AlignInput {
  /** mono samples, -1..1 */
  samples: Float32Array;
  sampleRate: number;
}

export interface AlignResult {
  /** aligned dub on the guide grid (guide length; = dub when strength 0) */
  aligned: Float32Array;
  /** matched anchor pairs (0 → nothing aligned, aligned is a copy of dub) */
  anchors: number;
  /** guide length in samples (output length) */
  length: number;
}

const HOP = 0.01; // envelope hop (s)
const MIN_ONSET_SPACING = 0.15; // s
const WSOLA_WIN = 0.03; // s
const WSOLA_OHOP = 0.01; // s
const WSOLA_SEARCH = 0.005; // s

function envelope(x: Float32Array, sr: number, hopS = HOP): { env: Float32Array; hop: number } {
  const hop = Math.max(1, Math.round(hopS * sr));
  const n = Math.max(1, Math.floor(x.length / hop));
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const start = i * hop;
    const end = Math.min(x.length, start + hop);
    for (let j = start; j < end; j++) sum += x[j] * x[j];
    env[i] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return { env, hop };
}

/** Energy-rise onsets: local level jumps over an adaptive floor. */
function pickOnsets(env: Float32Array, hop: number, sr: number): number[] {
  let peak = 0;
  let mean = 0;
  for (let i = 0; i < env.length; i++) { peak = Math.max(peak, env[i]); mean += env[i]; }
  mean /= Math.max(1, env.length);
  if (peak <= 0) return [];
  const floor = Math.max(mean * 0.5, peak * 0.05);
  const minGap = Math.max(1, Math.round((MIN_ONSET_SPACING * sr) / hop));
  const rise = Math.max(2e-4, peak * 0.08);
  const onsets: number[] = [];
  let last = -minGap;
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] <= floor) continue;
    if (env[i] - env[i - 1] < rise) continue;
    if (i - last < minGap) continue;
    onsets.push((i * hop) / sr); // seconds
    last = i;
  }
  return onsets;
}

/**
 * Piecewise-linear map from guide time (s) to dub time (s).
 * Anchors: matched (guideT, dubT) pairs + endpoints (0,0)/(gLen,dLen).
 * Per-segment rate is clamped to [1/maxStretch, maxStretch].
 */
function buildTimeMap(
  anchors: Array<[number, number]>, guideLenS: number, dubLenS: number, maxStretch: number,
): (t: number) => number {
  const pts: Array<[number, number]> = [[0, 0], ...anchors, [guideLenS, dubLenS]];
  // enforce monotonic + rate-clamped segments forward, then pull back in bounds
  for (let i = 1; i < pts.length; i++) {
    const [gt0, dt0] = pts[i - 1];
    const gSeg = Math.max(1e-6, pts[i][0] - gt0);
    let dSeg = pts[i][1] - dt0;
    const lo = gSeg / maxStretch;
    const hi = gSeg * maxStretch;
    dSeg = Math.min(hi, Math.max(lo, dSeg));
    pts[i] = [pts[i][0], dt0 + dSeg];
  }
  return (t: number): number => {
    const tt = Math.min(guideLenS, Math.max(0, t));
    for (let i = 1; i < pts.length; i++) {
      if (tt <= pts[i][0] || i === pts.length - 1) {
        const [g0, d0] = pts[i - 1];
        const [g1, d1] = pts[i];
        const f = (tt - g0) / Math.max(1e-6, g1 - g0);
        return d0 + f * (d1 - d0);
      }
    }
    return Math.min(dubLenS, tt); // unreachable
  };
}

function hannAt(p: number): number {
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
}

/** WSOLA: read dub at map(t) and re-stitch at fixed hop — pitch-preserving. */
function wsola(dub: Float32Array, sr: number, map: (t: number) => number, outLenS: number): Float32Array {
  const out = new Float32Array(Math.round(outLenS * sr));
  const win = Math.round(WSOLA_WIN * sr);
  const hop = Math.max(1, Math.round(WSOLA_OHOP * sr));
  const search = Math.round(WSOLA_SEARCH * sr);
  if (win < 4 || dub.length < win) {
    // nothing to granulate — nearest read
    for (let o = 0; o < out.length; o++) {
      const p = Math.round(map(o / sr) * sr);
      out[o] = dub[Math.min(dub.length - 1, Math.max(0, p))] ?? 0;
    }
    return out;
  }
  // first frame straight onto the output
  const read = (dubPos: number, dst: Float32Array, dstAt: number, add: boolean) => {
    const s0 = Math.round(dubPos * sr);
    for (let k = 0; k < win; k++) {
      const v = dub[s0 + k] ?? 0;
      const w = hannAt(k / win);
      const idx = dstAt + k;
      if (idx < 0 || idx >= dst.length) continue;
      dst[idx] = add ? (dst[idx] ?? 0) + v * w : v * w;
    }
  };
  read(map(0), out, 0, false);
  let lastOut = win; // next frame goes at lastOut
  const refFrom = () => Math.max(0, lastOut - win);
  while (lastOut + win <= out.length) {
    const idealIn = map(lastOut / sr) * sr;
    // continuity: search analysis offsets that best match the output tail
    let bestOff = 0;
    let bestErr = Infinity;
    for (let off = -search; off <= search; off += Math.max(1, Math.round(search / 8))) {
      const in0 = Math.round(idealIn + off);
      if (in0 < 0 || in0 + win > dub.length) continue;
      let err = 0;
      const overlapStart = lastOut - win + Math.round(win * 0.5);
      for (let k = Math.max(0, overlapStart - refFrom()); k < win; k += 4) {
        const a = out[lastOut - win + k];
        const b = dub[in0 + k] ?? 0;
        err += (a - b) * (a - b);
      }
      if (err < bestErr) { bestErr = err; bestOff = off; }
    }
    const in0 = Math.round(idealIn + bestOff);
    if (in0 < 0 || in0 + win > dub.length) break;
    // overlap-add with the tail of the previous frame
    const s0 = in0;
    for (let k = 0; k < win; k++) {
      const idx = lastOut + k;
      if (idx >= out.length) break;
      const w = hannAt(k / win);
      out[idx] = out[idx] * (1 - w) + (dub[s0 + k] ?? 0) * w;
    }
    lastOut += hop;
  }
  return out;
}

/** Linear resample (used for dub→guide sample-rate matching + dry blend). */
export function linearResample(x: Float32Array, outLen: number): Float32Array {
  const out = new Float32Array(outLen);
  if (x.length === 0 || outLen === 0) return out;
  const scale = (x.length - 1) / Math.max(1, outLen - 1);
  for (let i = 0; i < outLen; i++) {
    const p = i * scale;
    const i0 = Math.floor(p);
    const f = p - i0;
    out[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? 0) * f;
  }
  return out;
}

/** Align `dub` onto `guide`. Pure & deterministic. */
export function alignVocal(guide: Float32Array, dub: Float32Array, sr: number, strength = 1, maxStretch = 2): AlignResult {
  const guideLen = guide.length;
  const dubLen = dub.length;
  const guideLenS = guideLen / sr;
  const dubLenS = dubLen / sr;
  if (guideLen < sr * 0.2 || dubLen < sr * 0.2) {
    return { aligned: dub.slice(0, Math.max(0, guideLen)), anchors: 0, length: guideLen };
  }
  const eG = envelope(guide, sr);
  const eD = envelope(dub, sr);
  const onG = pickOnsets(eG.env, eG.hop, sr);
  const onD = pickOnsets(eD.env, eD.hop, sr);

  // Monotonic greedy matching with rate-clamped expectations.
  const anchors: Array<[number, number]> = [];
  let prevG = 0, prevD = 0, dj = 0;
  const scale = dubLenS / guideLenS;
  for (const gT of onG) {
    if (gT <= prevG + MIN_ONSET_SPACING) continue;
    const expect = prevD + (gT - prevG) * scale;
    const win = Math.min(1.0, 0.5 * (gT - prevG) * (maxStretch - 1) + 0.25);
    let best: { d: number; err: number } | null = null;
    for (let j = dj; j < onD.length; j++) {
      const err = Math.abs(onD[j] - expect);
      if (err > win && onD[j] > expect) break; // sorted: further ones only get worse
      if (onD[j] <= prevD) continue;
      if (!best || err < best.err) best = { d: onD[j], err };
    }
    if (!best) continue;
    anchors.push([gT, Math.min(dubLenS, Math.max(prevD + 1e-6, best.d))]);
    prevG = gT;
    prevD = anchors[anchors.length - 1][1];
    dj = onD.findIndex((d) => d === best!.d) + 1;
  }

  if (anchors.length === 0) {
    // guide/dub silence or no matchable structure → passthrough (documented)
    return { aligned: dub.slice(0, Math.max(0, guideLen)), anchors: 0, length: guideLen };
  }

  const s = Math.min(1, Math.max(0, strength));
  if (s === 0) return { aligned: dub.slice(0, Math.max(0, guideLen)), anchors: anchors.length, length: guideLen };

  const map = buildTimeMap(anchors, guideLenS, dubLenS, Math.max(1.01, maxStretch));
  const stretched = wsola(dub, sr, map, guideLenS);
  const dry = linearResample(dub, guideLen);
  const aligned = new Float32Array(guideLen);
  for (let i = 0; i < guideLen; i++) aligned[i] = dry[i] * (1 - s) + stretched[i] * s;
  return { aligned, anchors: anchors.length, length: guideLen };
}

/** Downmix stereo to mono for analysis/processing (align works on mono). */
export function toMono(left: Float32Array, right: Float32Array): Float32Array {
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i] + right[i]) * 0.5;
  return out;
}
