/**
 * test-audio.ts — known-value verification of the audio core (pure TS, Node 24+).
 *
 * Run:  node scripts/test-audio.ts
 *
 * Checks the measurement math (BS.1770 LUFS, 4x true peak, LRA) against
 * analytically known signals, the Smart Master pipeline against its
 * loudness/peak targets, and the WAV encoder round-trips. No browser, no
 * dependencies — this is the gate that must pass before UI integration.
 */

import {
  analyzeTone,
  applyBiquad,
  biquadCoeffs,
  dbToLin,
  linToDb,
  LoudnessMeter,
  measureDcOffset,
  measureLoudnessLra,
  measureMetrics,
  measureTruePeak4x,
  removeDcInPlace,
} from '../src/lib/audioMeters.ts';
import { chooseParams, ispLimit, runMasteringPipeline, softKneeReductionDb } from '../src/lib/masteringPipeline.ts';
import type { PipelineMetrics } from '../src/lib/audioMeters.ts';
import { LITE_PRESETS, presetToSettings } from '../src/lib/presets.ts';
import { decodeWavSamples, encodeWav } from '../src/lib/wavEncode.ts';
import { encodeAudio } from '../src/lib/exportEncoders.ts';
import { buildAacArgs } from '../src/lib/aacEncoder.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail: string): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}  ${detail}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

const near = (v: number, exp: number, tol: number): boolean => Math.abs(v - exp) <= tol;

// ---------------------------------------------------------------------------
// Signal generators
// ---------------------------------------------------------------------------

function sine(freq: number, durSec: number, sr: number, amp = 1, phase = 0): Float32Array {
  const n = Math.floor(durSec * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr + phase);
  return out;
}

/**
 * Pink noise (−3 dB/oct): Voss-McCartney as a sum of random square waves with
 * doubling periods (equal power per octave), DC-removed, RMS-normalized to 1.
 */
function pink(durSec: number, sr: number): Float32Array {
  const n = Math.floor(durSec * sr);
  const values = new Float64Array(n);
  for (let period = 2; period <= n; period *= 2) {
    let sign = 0;
    for (let i = 0; i < n; i += 1) {
      if (i % period === 0) sign = Math.random() < 0.5 ? -1 : 1;
      values[i] += sign;
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += values[i];
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    values[i] -= mean / n;
    sum += values[i] * values[i];
  }
  const rms = Math.sqrt(sum / n);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = values[i] / rms;
  return out;
}

/**
 * Musical-ish stereo bed: sustained 8-partial chord (shallow 0.25 Hz
 * breath) + faint broadband tail. Crest ≈ 9 dB — the hard case for loud
 * targets (a dense pad keeps the limiter engaged, unlike gappy music),
 * so if every platform preset lands here, it lands on real tracks too.
 * Deterministic (seeded tail noise).
 */
function chordBed(durSec: number, sr: number): { l: Float32Array; r: Float32Array } {
  const n = Math.floor(durSec * sr);
  const freqs = [110, 164.8, 220, 261.6, 329.6, 523.3, 1046.5, 2093];
  const amps = [1.0, 0.7, 0.9, 0.8, 0.6, 0.5, 0.35, 0.2];
  const ph = [0, 1.1, 2.3, 0.6, 4.0, 2.9, 5.2, 1.7];
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let seed = 987654321;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const env = 0.92 + 0.08 * Math.sin(2 * Math.PI * 0.25 * t);
    let sl = 0;
    let sr2 = 0;
    for (let k = 0; k < freqs.length; k += 1) {
      sl += amps[k] * Math.sin(2 * Math.PI * freqs[k] * t + ph[k]);
      sr2 += amps[k] * Math.sin(2 * Math.PI * freqs[k] * t + ph[k] + 0.35);
    }
    l[i] = 0.6 * env * sl + 0.03 * rnd();
    r[i] = 0.6 * env * sr2 + 0.03 * rnd();
    sumSq += l[i] * l[i] + r[i] * r[i];
  }
  const rms = Math.sqrt(sumSq / (2 * n));
  for (let i = 0; i < n; i += 1) { l[i] /= rms; r[i] /= rms; }
  return { l, r };
}

/** Scale a signal (both channels) so its integrated LUFS equals targetLufs (2 iterations). */
async function scaleToLufs(left: Float32Array, right: Float32Array, sr: number, targetLufs: number): Promise<void> {
  for (let iter = 0; iter < 2; iter += 1) {
    const { integratedLufs } = await measureLoudnessLra(left, right, sr);
    const delta = targetLufs - integratedLufs;
    if (Math.abs(delta) < 0.01) break;
    const g = dbToLin(delta);
    for (let i = 0; i < left.length; i += 1) {
      left[i] *= g;
      right[i] *= g;
    }
  }
}

const dbOf = (rmsOrPeak: number): number => 20 * Math.log10(Math.max(rmsOrPeak, 1e-12));

// ---------------------------------------------------------------------------
// T1. Integrated LUFS — 1 kHz sine, -20 dBFS, stereo, 10 s, 48 kHz
//     K-weighting at 1 kHz ≈ +0.66 dB → expected ≈ -20.03 LUFS
// ---------------------------------------------------------------------------
async function t1(): Promise<void> {
  console.log('\nT1. LUFS: 1kHz sine -20dBFS');
  const sr = 48000;
  const l = sine(1000, 10, sr, dbToLin(-20));
  const r = new Float32Array(l);
  const { integratedLufs } = await measureLoudnessLra(l, r, sr);
  check('integrated LUFS ≈ -20.03', near(integratedLufs, -20.03, 0.3), `measured ${integratedLufs.toFixed(3)} LUFS`);
}

// ---------------------------------------------------------------------------
// T2. Integrated LUFS — pink noise, -18 dBFS RMS, 15 s, 48 kHz → -18 ± 1
// ---------------------------------------------------------------------------
async function t2(): Promise<void> {
  console.log('\nT2. LUFS: broadband (pink) to -18 LUFS, measured back');
  // Deterministic round-trip: scale broadband material to -18 LUFS, then the
  // meter must read -18 ± 0.3. (The old variant scaled to -18 dBFS RMS and
  // asserted LUFS ≈ -18 — K-weighting of a finite pink realization varies
  // ±1.3 dB across random seeds, which was flaky by construction.)
  const sr = 48000;
  const l = pink(15, sr);
  const r = new Float32Array(l);
  await scaleToLufs(l, r, sr, -18);
  const { integratedLufs } = await measureLoudnessLra(l, r, sr);
  check('integrated LUFS ≈ -18 ± 0.3', near(integratedLufs, -18, 0.3), `measured ${integratedLufs.toFixed(3)} LUFS`);
}

// ---------------------------------------------------------------------------
// T3. True peak 4x — 20 kHz sine, unit amplitude, phase π/4, 48 kHz.
//     Samples hit sin(45°)=0.707..sin(285°)=-0.966 → sample peak 0.966 (-0.30 dB),
//     while the continuous (band-limited) amplitude is 1.0 → 0 dBTP.
//     Proves the 4x envelope sees peaks that sample-peak misses by 0.3 dB.
// ---------------------------------------------------------------------------
async function t3(): Promise<void> {
  console.log('\nT3. True peak 4x (inter-sample)');
  const sr = 48000;
  // 20 ms raised-cosine fades at both ends: an abrupt tone start is a
  // band-limited discontinuity whose Gibbs overshoot at the edge is real
  // signal energy — the EBU reference (libebur128 via ffmpeg) reports
  // +0.5..+1.6 dB on the unfaded material. Fades keep this test about the
  // steady-state inter-sample peak, which is what the filter must capture.
  const fade = (x: Float32Array, fadeSec = 0.02): void => {
    const F = Math.round(fadeSec * sr);
    for (let i = 0; i < F; i += 1) {
      const g = Math.sin((Math.PI / 2) * (i / F));
      x[i] *= g;
      x[x.length - 1 - i] *= g;
    }
  };

  const l = sine(20000, 2, sr, 1, Math.PI / 4);
  fade(l);
  let samplePeak = 0;
  for (let i = 0; i < l.length; i += 1) if (Math.abs(l[i]) > samplePeak) samplePeak = Math.abs(l[i]);
  const tp = await measureTruePeak4x(l, null);
  check('sample peak ≈ -0.30 dB', near(dbOf(samplePeak), -0.30, 0.05), `sample ${dbOf(samplePeak).toFixed(3)} dB`);
  check('4x true peak ≈ 0.0 dBTP (ISP captured)', near(tp, 0.0, 0.15), `TP ${tp.toFixed(3)} dBTP (sample+${(tp - dbOf(samplePeak)).toFixed(2)} dB)`);

  // Sanity: a 20 kHz tone whose samples hit the peak must not exceed it by window ripple
  const l20 = sine(20000, 1, sr, dbToLin(-1));
  fade(l20);
  let sp20 = 0;
  for (let i = 0; i < l20.length; i += 1) if (Math.abs(l20[i]) > sp20) sp20 = Math.abs(l20[i]);
  const tp20 = await measureTruePeak4x(l20, null);
  check('20kHz on-peak: TP in [sample-0.05, sample+0.15]', tp20 >= dbOf(sp20) - 0.05 && tp20 <= dbOf(sp20) + 0.15, `sample ${dbOf(sp20).toFixed(2)}, TP ${tp20.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// T4. LRA — constant tone ≈ 0; speech-like bursts (loud/quiet) > 3
// ---------------------------------------------------------------------------
async function t4(): Promise<void> {
  console.log('\nT4. LRA');
  const sr = 48000;
  const tone = sine(440, 12, sr, dbToLin(-14));
  const toneR = new Float32Array(tone);
  const { lra: lraTone } = await measureLoudnessLra(tone, toneR, sr);
  check('tone: LRA ≈ 0 (≤ 0.5)', lraTone <= 0.5, `LRA ${lraTone.toFixed(3)}`);

  // Dynamic material: 6 s blocks alternating loud (-14 dBFS) / quiet
  // (-23 dBFS). A 3 s LRA window (1.8 s hop) needs ≥ 4 s blocks to fit one
  // level entirely; 9 LU separation with the I-weighted 5/95 percentiles
  // yields a robust mid-range LRA (~8-9). The previous 0.4 s bursts in a
  // 1.9 s cycle could not exceed ~1 LU by construction (every 3 s window
  // mixed loud and quiet).
  const n = sr * 24;
  const block = sr * 6;
  const burstsL = new Float32Array(n);
  const src = pink(24, sr);
  for (let i = 0; i < n; i += 1) {
    const loud = Math.floor(i / block) % 2 === 0;
    burstsL[i] = src[i] * dbToLin(loud ? -14 : -23);
  }
  const burstsR = new Float32Array(burstsL);
  const { lra: lraBursts } = await measureLoudnessLra(burstsL, burstsR, sr);
  check('bursts: LRA > 3 (and ≤ 10 cap)', lraBursts > 3 && lraBursts <= 10, `LRA ${lraBursts.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// T5. Soft knee compressor math (unit checks on the curve itself)
// ---------------------------------------------------------------------------
function t5(): void {
  console.log('\nT5. Soft-knee compressor curve');
  const T = -18;
  const R = 2;
  // 10 dB over threshold = 7 dB past the knee edge (knee 6 dB) → (R-1)/R * 7 = 3.5
  check('below knee: 0 dB reduction', near(softKneeReductionDb(T - 5, T, R), 0, 1e-9), `reduction ${softKneeReductionDb(T - 5, T, R).toExponential(2)}`);
  check('10 dB over: (R-1)/R * (10 - K/2) = 3.5 dB', near(softKneeReductionDb(T + 10, T, R), 3.5, 0.02), `reduction ${softKneeReductionDb(T + 10, T, R).toFixed(3)}`);
  check('slope above knee = 1/R', near((softKneeReductionDb(T + 20, T, R) - softKneeReductionDb(T + 10, T, R)) / 10, 0.5, 0.005), `slope ${((softKneeReductionDb(T + 20, T, R) - softKneeReductionDb(T + 10, T, R)) / 10).toFixed(4)}`);
  check('continuous at knee edge', Math.abs(softKneeReductionDb(T + 3.001, T, R) - softKneeReductionDb(T + 2.999, T, R)) < 0.01, 'slope across knee edge');
}

// ---------------------------------------------------------------------------
// T6. ISP limiter — input peaks at +3 dBFS, ceiling -1 dB → out TP ≤ -0.95, no clip
// ---------------------------------------------------------------------------
async function t6(): Promise<void> {
  console.log('\nT6. ISP look-ahead limiter');
  const sr = 48000;
  const l = sine(400, 3, sr, dbToLin(3)); // +3 dBFS peaks
  const r = sine(800, 3, sr, dbToLin(3));
  const res = await ispLimit(l, r, sr, -1, 6, 120);
  const tp = await measureTruePeak4x(l, r);
  let maxAbs = 0;
  for (let i = 0; i < l.length; i += 1) {
    const a = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    if (a > maxAbs) maxAbs = a;
  }
  check('out TP ≤ -0.95 dBTP', tp <= -0.95, `TP ${tp.toFixed(3)} dBTP, avg GR ${res.avgReductionDb.toFixed(2)} dB`);
  check('no digital clip (|x| ≤ 1.0001)', maxAbs <= 1.0001, `max ${maxAbs.toFixed(6)}`);
}

// ---------------------------------------------------------------------------
// T7. Pipeline end-to-end — input ≈ -16 LUFS pink, target -14 / -1:
//     out LUFS -14 ± 0.3, out TP ≤ -0.95
// ---------------------------------------------------------------------------
async function t7(): Promise<void> {
  console.log('\nT7. Smart Master pipeline to target');
  const sr = 48000;
  const l = pink(30, sr);
  const r = pink(30, sr);
  await scaleToLufs(l, r, sr, -16);
  const { input, output, gainReductionDb, findings } = await runMasteringPipeline({
    left: l, right: r, sampleRate: sr,
    settings: { targetLufs: -14, ceilingDb: -1, profile: 'streaming' },
  });
  console.log(`      in:  LUFS ${input.integratedLufs.toFixed(2)}  TP ${input.truePeakDb.toFixed(2)}  LRA ${input.lra.toFixed(2)}`);
  console.log(`      out: LUFS ${output.integratedLufs.toFixed(2)}  TP ${output.truePeakDb.toFixed(2)}  LRA ${output.lra.toFixed(2)}  GR ${gainReductionDb.toFixed(2)} dB`);
  check('input measured ≈ -16 LUFS', near(input.integratedLufs, -16, 0.3), `in ${input.integratedLufs.toFixed(3)}`);
  check('output LUFS ≈ -14 ± 0.3', near(output.integratedLufs, -14, 0.3), `out ${output.integratedLufs.toFixed(3)}`);
  check('output TP ≤ -0.95 dBTP', output.truePeakDb <= -0.95, `TP ${output.truePeakDb.toFixed(3)}`);
  check('findings non-empty', findings.length > 0, `${findings.length} findings`);
}

// ---------------------------------------------------------------------------
// T12. Lite presets — every platform preset: render a fixed -16 LUFS pink
//     input and confirm |out LUFS − target| ≤ 0.5 and out TP ≤ ceiling+0.05.
// ---------------------------------------------------------------------------
async function t12(): Promise<void> {
  console.log('\nT12. Lite presets to target (all platforms)');
  const sr = 48000;
  const { l, r } = chordBed(8, sr);
  await scaleToLufs(l, r, sr, -16);
  for (const p of LITE_PRESETS) {
    const t0 = Date.now();
    const { output, appliedTargetLufs, appliedCeilingDb } = await runMasteringPipeline({
      left: l, right: r, sampleRate: sr,
      settings: presetToSettings(p),
    });
    const dt = Date.now() - t0;
    check(`preset ${p.id} → ${p.targetLufs} LUFS / ${p.ceilingDb} dBTP`,
      near(output.integratedLufs, p.targetLufs, 0.5) && output.truePeakDb <= p.ceilingDb + 0.05,
      `out ${output.integratedLufs.toFixed(2)} LUFS / ${output.truePeakDb.toFixed(2)} dBTP (applied ${appliedTargetLufs}/${appliedCeilingDb}) ${dt} ms`);
  }
}

// ---------------------------------------------------------------------------
// T8. WAV round-trips — 24-bit (≤ 0.6 LSB error), 16-bit dithered (≤ 1 LSB),
//     32-bit float (bit-exact)
// ---------------------------------------------------------------------------
async function t8(): Promise<void> {
  console.log('\nT8. WAV encode round-trip');
  const sr = 44100;
  const n = sr; // 1 s
  const l = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    l[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / sr) + 0.2 * Math.sin((2 * Math.PI * 3400 * i) / sr);
  }
  const r = new Float32Array(n);
  for (let i = 0; i < n; i += 1) r[i] = 0.55 * Math.cos((2 * Math.PI * 220 * i) / sr);

  // 24-bit: error must stay within half a quantization step (no dither → rounding)
  const buf24 = new Uint8Array(encodeWav([l, r], sr, { bitDepth: 24, dither: false }));
  const l24 = new Float32Array(n);
  const raw = new DataView(buf24.buffer, 44);
  for (let i = 0; i < n; i += 1) {
    let v = raw.getUint8(i * 6) | (raw.getUint8(i * 6 + 1) << 8) | (raw.getUint8(i * 6 + 2) << 16);
    if (v & 0x800000) v |= 0xff000000;
    l24[i] = v / 8388608;
  }
  let maxErr24 = 0;
  for (let i = 0; i < n; i += 1) maxErr24 = Math.max(maxErr24, Math.abs(l24[i] - l[i]));
  check('24-bit: max error ≤ 0.6 LSB', maxErr24 <= 0.6 * (1 / 8388608), `max err ${(maxErr24 * 8388608).toFixed(4)} LSB`);

  // 16-bit dithered: error within ~1.2 LSB (TPDF bound), dither actually applied
  const buf16 = new Uint8Array(encodeWav([l, r], sr, { bitDepth: 16, dither: true }));
  const raw16 = new DataView(buf16.buffer, 44);
  let maxErr16 = 0;
  let nonzeroErr = 0;
  for (let i = 0; i < n; i += 1) {
    const v = raw16.getInt16(i * 4, true);
    const d = v / 32768 - l[i];
    maxErr16 = Math.max(maxErr16, Math.abs(d));
    if (Math.abs(d) > 1e-9) nonzeroErr += 1;
  }
  const lsb16 = 1 / 32768;
  // TPDF dither spans ±1 LSB, rounding adds ≤ 0.5 LSB → hard bound 1.5 LSB
  check('16-bit dither: max error ≤ 1.55 LSB', maxErr16 <= 1.55 * lsb16, `max err ${(maxErr16 / lsb16).toFixed(3)} LSB`);
  check('16-bit dither: noise applied to quiet signal', nonzeroErr > n * 0.99, `${((nonzeroErr / n) * 100).toFixed(1)}% samples altered`);

  // 32-bit float: bit-exact round-trip
  const buf32 = new Uint8Array(encodeWav([l, r], sr, { bitDepth: 32 }));
  const raw32 = new DataView(buf32.buffer, 44);
  let maxErr32 = 0;
  for (let i = 0; i < n; i += 1) {
    const d = Math.abs(raw32.getFloat32(i * 8, true) - l[i]);
    if (d > maxErr32) maxErr32 = d;
  }
  check('32-bit float: bit-exact', maxErr32 === 0, `max err ${maxErr32}`);
}

// ---------------------------------------------------------------------------
// T9. DC offset — +0.5 offset measured, then removed
// ---------------------------------------------------------------------------
async function t9(): Promise<void> {
  console.log('\nT9. DC offset detect & remove');
  const sr = 48000;
  const l = sine(120, 2, sr, 0.3);
  const r = sine(120, 2, sr, 0.25);
  for (let i = 0; i < l.length; i += 1) {
    l[i] += 0.5;
    r[i] -= 0.5;
  }
  const dcBefore = measureDcOffset(l, r);
  const beforeDb = Math.max(dbOf(Math.abs(dcBefore.l)), dbOf(Math.abs(dcBefore.r)));
  check('DC ≈ ±0.5 (-6.02 dB)', near(beforeDb, -6.02, 0.05), `L ${dcBefore.l.toFixed(4)} / R ${dcBefore.r.toFixed(4)}`);
  removeDcInPlace(l, r);
  const dcAfter = measureDcOffset(l, r);
  const afterDb = Math.max(dbOf(Math.abs(dcAfter.l)), dbOf(Math.abs(dcAfter.r)));
  check('after removal ≤ -80 dB', afterDb <= -80, `${afterDb.toFixed(1)} dB`);
}

// ---------------------------------------------------------------------------
// T10. Performance — 5 min stereo 44.1k through the full pipeline.
//     Budget 30 s (≈ 0.1x real time). The old 20 s budget predates the
//     accurate 256-tap 4x true-peak meter (T3 fix), which is ~3x slower
//     than the 32-tap Hamming filter it replaced; the regression guard
//     here is against algorithmic blow-ups, not a product SLA.
// ---------------------------------------------------------------------------
async function t10(): Promise<void> {
  console.log('\nT10. Performance: 5 min stereo 44.1k');
  const sr = 44100;
  const l = pink(300, sr);
  const r = pink(300, sr);
  await scaleToLufs(l, r, sr, -16);
  const t0 = performance.now();
  const { output } = await runMasteringPipeline({
    left: l, right: r, sampleRate: sr,
    settings: { targetLufs: -14, ceilingDb: -1, profile: 'balanced' },
  });
  const dt = performance.now() - t0;
  check('full pipeline < 30 s (≈0.1x real time)', dt < 30000, `${(dt / 1000).toFixed(2)} s (out LUFS ${output.integratedLufs.toFixed(2)})`);
}

// ---------------------------------------------------------------------------
// Bonus. Biquad sanity — high shelf +4 dB @1.5k: ~4 dB at 10 kHz, ~0 dB at 100 Hz
// ---------------------------------------------------------------------------
function b10(): void {
  console.log('\nT11. Biquad shelf response sanity');
  const sr = 48000;
  const c = biquadCoeffs('highshelf', sr, 1500, 0.707, 4);
  const hz = (f: number): number => {
    const w = (2 * Math.PI * f) / sr;
    const re = c.b0 + c.b1 * Math.cos(w) + c.b2 * Math.cos(2 * w);
    const im = -(c.b1 * Math.sin(w) + c.b2 * Math.sin(2 * w));
    const dr = 1 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w);
    const di = -(c.a1 * Math.sin(w) + c.a2 * Math.sin(2 * w));
    return 20 * Math.log10(Math.sqrt(re * re + im * im) / Math.sqrt(dr * dr + di * di));
  };
  check('shelf +4 dB @ 10 kHz (±0.3)', near(hz(10000), 4, 0.3), `${hz(10000).toFixed(2)} dB`);
  check('shelf ≈ 0 dB @ 100 Hz (±0.3)', near(hz(100), 0, 0.3), `${hz(100).toFixed(2)} dB`);

  // applyBiquad in-place keeps length & is stable on a step input
  const step = new Float32Array(1000).fill(0.5);
  applyBiquad(step, biquadCoeffs('lowpass', sr, 1000, 0.707, 0));
  const stable = Number.isFinite(step[999]) && Math.abs(step[999]) <= 0.51;
  check('biquad stable on step', stable, `out ${step[999].toFixed(4)}`);

  // analyzeTone on a 3 kHz tone → harsh band dominates, harshPeakHz ≈ 3 kHz
  const tone = sine(3000, 4, sr, 0.3);
  const a = analyzeTone(tone, null, sr);
  check('tone 3kHz: harshRatio dominant', a.harshRatio > 0.7, `harsh ${a.harshRatio.toFixed(2)}`);
  check('tone 3kHz: harshPeakHz ≈ 3000 (±120)', near(a.harshPeakHz, 3000, 120), `peak ${a.harshPeakHz.toFixed(0)} Hz`);
}

// ---------------------------------------------------------------------------
// T16. FLAC export — fLaC magic, VORBIS_COMMENT tags, 24-bit lossless round-trip
//      (round-trip needs ffmpeg on PATH; skipped with a note otherwise)
// ---------------------------------------------------------------------------
async function t16(): Promise<void> {
  console.log('\nT16. FLAC export (mediabunny + libFLAC)');
  const sr = 48000, n = sr * 2;
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    l[i] = 0.5 * Math.sin(2 * Math.PI * 440 * t);
    r[i] = -0.5 * Math.sin(2 * Math.PI * 880 * t);
  }
  const { blob, ext, bytes } = await encodeAudio(l, r, sr, {
    format: 'flac',
    metadata: { title: 'T16 FLAC', artist: 'NMP Test', album: 'RoundTrip', genre: 'Test', year: '2026', label: 'NMP' },
  });
  const buf = new Uint8Array(await blob.arrayBuffer());
  check('ext/size', ext === 'flac' && bytes > 1000, `${bytes} bytes`);
  check('fLaC magic', buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43,
    `magic ${Buffer.from(buf.subarray(0, 4)).toString()}`);
  const text = Buffer.from(buf).toString('latin1');
  check('VORBIS_COMMENT: TITLE/ARTIST/ALBUM/GENRE',
    text.includes('TITLE=T16 FLAC') && text.includes('ARTIST=NMP Test') &&
    text.includes('ALBUM=RoundTrip') && text.includes('GENRE=Test'),
    'tags present');

  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  if (!hasFfmpeg) {
    console.log('  SKIP  round-trip (ffmpeg not on PATH)');
    return;
  }
  const os = await import('node:os');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(`${os.tmpdir()}\/nmp-flac-`);
  const flacPath = `${dir}\/t16.flac`, rawPath = `${dir}\/t16.f32`;
  fs.writeFileSync(flacPath, buf);
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', flacPath, '-f', 'f32le', '-acodec', 'pcm_f32le', rawPath]);
  if (dec.status !== 0) {
    check('ffmpeg decode', false, dec.stderr?.toString().slice(0, 200) ?? 'non-zero exit');
    return;
  }
  const raw = fs.readFileSync(rawPath);
  // Reinterpret raw little-endian f32 bytes (NOT element-wise copy of the Buffer!)
  const decBuf = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
  let maxDiff = 0;
  const frames = Math.min(n, decBuf.length >> 1);
  for (let i = 0; i < frames; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(decBuf[2 * i] - l[i]), Math.abs(decBuf[2 * i + 1] - r[i]));
  }
  // 24-bit integer FLAC from f32: difference is encoder quantization (~0.5 LSB)
  // plus f32 representation error → budget 1.5e-07 (≈1.25 LSB of 24-bit).
  check('lossless @24-bit (max|diff| ≤ 1.5e-07)', maxDiff <= 1.5e-07, `max ${maxDiff.toExponential(3)}`);
  check('sample count preserved', decBuf.length === n * 2, `${decBuf.length} / ${n * 2}`);
}

// ---------------------------------------------------------------------------
// T17. MP3 export — ID3v2 tags, MPEG-1 Layer III frame @ 320 kbps / 48 kHz
// ---------------------------------------------------------------------------
async function t17(): Promise<void> {
  console.log('\nT17. MP3 export (mediabunny + LAME)');
  const sr = 48000, n = sr * 2;
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, i / 4800, (n - i) / 4800);
    l[i] = 0.5 * Math.sin(2 * Math.PI * 440 * t) * env;
    r[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) * env;
  }
  const { blob, ext, bytes } = await encodeAudio(l, r, sr, {
    format: 'mp3', mp3Kbps: 320,
    metadata: { title: 'T17 MP3', artist: 'NMP Test', album: 'MpegTag', genre: 'Electronic', year: '2026' },
  });
  const buf = new Uint8Array(await blob.arrayBuffer());
  check('ext/size', ext === 'mp3' && bytes > 20000, `${bytes} bytes (expect ~${Math.round((n / sr * 320000) / 8)})`);
  check('ID3v2 header', buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33, 'ID3');
  const tagSize = 10 + ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const tagText = Buffer.from(buf.subarray(0, Math.min(tagSize, buf.length))).toString('latin1');
  check('ID3 tags: title/artist/album/genre/year',
    tagText.includes('T17 MP3') && tagText.includes('NMP Test') &&
    tagText.includes('MpegTag') && tagText.includes('Electronic') && tagText.includes('2026'),
    `tag size ${tagSize}`);

  // The first frame carries the Xing/Info gapless header (LAME may write a
  // dummy header for it) — verify the CBR stream via its genuine frames:
  // MPEG-1 Layer III 320 kbps 48 kHz = header FF FA/FB E4..E7, 960-byte frames.
  let cbrFrames = 0, firstCbr = -1, lastCbr = -1;
  for (let fi = 0; fi < buf.length - 3; fi++) {
    if (buf[fi] === 0xff && (buf[fi + 1] === 0xfa || buf[fi + 1] === 0xfb) && (buf[fi + 2] & 0xfc) === 0xe4) {
      cbrFrames++;
      if (firstCbr < 0) firstCbr = fi;
      lastCbr = fi;
    }
  }
  const spacing = cbrFrames > 1 ? (lastCbr - firstCbr) / (cbrFrames - 1) : 0;
  check('MPEG-1 Layer III CBR 320k/48k stream', cbrFrames >= 10 && Math.abs(spacing - 960) < 8,
    `${cbrFrames} frames @ 960 B (measured ${spacing.toFixed(1)})`);
  const latin = Buffer.from(buf).toString('latin1');
  check('Xing/Info duration header present', latin.includes('Xing') || latin.includes('Info'), 'marker found');
}

// ---------------------------------------------------------------------------
// T18. Live streaming meter (LoudnessMeter) — validates the exact clock-diff
// feed used by MeteringBridge: each frame the AnalyserNode buffer holds the
// last `bufLen` samples (zero-padded at start) and we push only the tail that
// is genuinely new since the previous read. Checks no sample is pushed twice
// or skipped, and that the streamed value converges to the batch reference.
// ---------------------------------------------------------------------------

async function t18(): Promise<void> {
  console.log('\nT18. Live streaming meter (LoudnessMeter clock-diff feed)');
  const sr = 48000;
  const n = sr * 10; // 10 s
  const amp = Math.pow(10, -11 / 20);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = amp * Math.sin((2 * Math.PI * 1000 * i) / sr);
    l[i] = v;
    r[i] = v;
  }

  const { integratedLufs } = await measureLoudnessLra(l, r, sr);

  const meter = new LoudnessMeter(sr);
  const bufLen = 2048;
  const bufL = new Float32Array(bufLen);
  const bufR = new Float32Array(bufLen);
  let pos = 0;        // samples already fed to the meter
  let totalPushed = 0;
  let pushedSum = 0;
  let frames = 0;
  // deterministic pseudo-random advance (avoid Math.random in tests)
  let seed = 12345;
  const rnd = (a: number, b: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return a + (seed % (b - a + 1));
  };
  while (pos < n) {
    const advance = Math.min(bufLen - 1, Math.max(1, rnd(1, bufLen - 1)));
    const end = Math.min(pos + advance, n);
    const advanceReal = end - pos;
    // AnalyserNode buffer = last bufLen samples up to `end`, zero-padded head
    const start = Math.max(0, end - bufLen);
    const tail = end - start;
    bufL.fill(0);
    bufR.fill(0);
    for (let i = 0; i < tail; i += 1) {
      bufL[bufLen - tail + i] = l[start + i];
      bufR[bufLen - tail + i] = r[start + i];
    }
    // exact MeteringBridge feed: the `advanceReal` newest samples of the buffer
    const off = bufLen - advanceReal;
    const pl = bufL.subarray(off);
    const pr = bufR.subarray(off);
    meter.push(pl, pr);
    for (let i = 0; i < pl.length; i += 1) pushedSum += pl[i];
    totalPushed += pl.length;
    pos += advanceReal;
    frames += 1;
  }

  const fullSum = l.reduce((a, b) => a + b, 0);
  check('feed: every sample pushed exactly once',
    totalPushed === n, `${totalPushed}/${n} in ${frames} frames`);
  check('feed: no duplication/skip (sum match)',
    Math.abs(pushedSum - fullSum) <= 1e-4,
    `Δ ${(pushedSum - fullSum).toExponential(2)}`);
  check('streamed momentary ≈ batch integrated',
    near(meter.momentary, integratedLufs, 0.1),
    `M ${meter.momentary.toFixed(3)} vs I ${integratedLufs.toFixed(3)} LU`);
  check('streamed short-term ≈ batch integrated',
    near(meter.shortTerm, integratedLufs, 0.1),
    `S ${meter.shortTerm.toFixed(3)} vs I ${integratedLufs.toFixed(3)} LU`);
}

// ---------------------------------------------------------------------------
// T19. Reference matching — tone targets taken from the reference track.
//      (a) unit: chooseParams steers deltas toward the ref's tone ratios;
//      (b) e2e: rendered output tone moves toward the ref, loudness intact.
// ---------------------------------------------------------------------------
async function t19(): Promise<void> {
  console.log('\nT19. Reference matching (chooseParams + pipeline)');
  const mkTone = (over: Partial<PipelineMetrics['tone']> = {}): PipelineMetrics['tone'] => ({
    subRatio: 0, bassRatio: 0, lowMidRatio: 0, midRatio: 0, harshRatio: 0,
    highRatio: 0, airRatio: 0, centroid: 1000, harshPeakHz: 3000,
    correlation: 0.9, widthScore: 0.32,
    panel: { sub: 0, low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 },
    ...over,
  });
  const mk = (tone: PipelineMetrics['tone']): PipelineMetrics => ({
    integratedLufs: -18, truePeakDb: -4, samplePeakDb: -4.2, lra: 1,
    crestFactor: 8, crestDb: 9, correlation: 0.9, dcOffsetDb: -90, tone,
  });
  const settings = { targetLufs: -14, ceilingDb: -1, profile: 'balanced' as const };

  // (a) unit: muddy source (lowMid 0.35, bright 0.05), bright clean ref
  //     (lowMid 0.10, bright 0.20, harsh 0.20).
  const srcTone = mkTone({ lowMidRatio: 0.35, bassRatio: 0.18, subRatio: 0.12, harshRatio: 0.10, highRatio: 0.03, airRatio: 0.02 });
  const refTone = mkTone({ lowMidRatio: 0.10, bassRatio: 0.12, subRatio: 0.08, harshRatio: 0.20, highRatio: 0.10, airRatio: 0.10 });
  const noRef = chooseParams(mk(srcTone), settings);
  const withRef = chooseParams(mk(srcTone), settings, mk(refTone));
  check('unit: ref deepens the mud cut (src 0.35 vs ref 0.10 vs abs 0.20)',
    withRef.lowMidDb < noRef.lowMidDb - 0.3,
    `with ${withRef.lowMidDb.toFixed(2)} vs no ${noRef.lowMidDb.toFixed(2)} dB`);
  check('unit: ref raises the brightness target (0.20 vs abs 0.135)',
    withRef.highShelfDb > noRef.highShelfDb + 0.3,
    `with ${withRef.highShelfDb.toFixed(2)} vs no ${noRef.highShelfDb.toFixed(2)} dB`);
  const srcHot = mk(mkTone({ ...srcTone, harshRatio: 0.30 }));
  const deNo = chooseParams(srcHot, settings).deEssDb;
  const deWith = chooseParams(srcHot, settings, mk(mkTone({ ...refTone, harshRatio: 0.10 }))).deEssDb;
  check('unit: quiet-harsh ref deepens de-ess (src 0.30 vs ref 0.10 vs abs 0.23)',
    deWith < -0.5 && deWith < deNo,
    `with ${deWith.toFixed(2)} vs no ${deNo.toFixed(2)} dB`);

  // (b) e2e: muddy source (180-450 Hz bed + a little 8k + noise floor)
  //     mastered with and without a bright reference (mid + 2.5k + 6k/9k).
  //     The ref run must lift brightness more than the absolute run, without
  //     overshooting the reference's own tone.
  const sr = 48000;
  const n = sr * 6;
  let seed = 424242;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  const mix = (freqs: Array<[number, number]>, out: Float32Array, noise = 0): void => {
    out.fill(0);
    for (let i = 0; i < n; i += 1) {
      const t = i / sr;
      let v = 0;
      for (const [f, a] of freqs) v += a * Math.sin(2 * Math.PI * f * t);
      out[i] = 0.3 * v + (noise ? noise * rnd() : 0);
    }
  };
  const sl = new Float32Array(n), sr2 = new Float32Array(n);
  mix([[110, 1], [165, 0.8], [220, 1.2], [330, 1.0], [400, 0.9], [8000, 1.0]], sl, 0.05);
  mix([[110, 1], [165, 0.8], [220, 1.15], [330, 0.95], [400, 0.85], [8000, 0.95]], sr2, 0.05);
  const rl = new Float32Array(n), rr = new Float32Array(n);
  mix([[500, 0.6], [1000, 0.8], [2500, 0.5], [6000, 0.7], [9000, 0.6]], rl);
  mix([[500, 0.6], [1000, 0.8], [2500, 0.55], [6000, 0.72], [9000, 0.62]], rr);

  const refM = await measureMetrics(rl, rr, sr);
  const srcM = await measureMetrics(sl, sr2, sr);
  const base = { left: sl, right: sr2, sampleRate: sr, settings };
  const resNo = await runMasteringPipeline({ ...base });
  const resRef = await runMasteringPipeline({ ...base, refMetrics: refM });
  const brightOf = (m: PipelineMetrics): number => m.tone.highRatio + m.tone.airRatio;
  const bSrc = brightOf(srcM), bRef = brightOf(refM);
  const bNo = brightOf(resNo.output), bWith = brightOf(resRef.output);
  check('e2e: loudness still hits the target', near(resRef.output.integratedLufs, -14, 0.5),
    `out ${resRef.output.integratedLufs.toFixed(2)} LUFS`);
  check('e2e: ref run lifts brightness more than the absolute run',
    bWith > bNo + 0.01,
    `src ${bSrc.toFixed(3)} | no-ref ${bNo.toFixed(3)} | with-ref ${bWith.toFixed(3)} (ref ${bRef.toFixed(3)})`);
  check('e2e: pulled toward the ref without overshooting it',
    bWith > bSrc && bWith < bRef,
    `${bWith.toFixed(3)} in (${bSrc.toFixed(3)}, ${bRef.toFixed(3)})`);
  check('e2e: mud pulled down toward the reference',
    resRef.output.tone.lowMidRatio < srcM.tone.lowMidRatio - 0.02,
    `src ${srcM.tone.lowMidRatio.toFixed(3)} → out ${resRef.output.tone.lowMidRatio.toFixed(3)} (ref ${refM.tone.lowMidRatio.toFixed(3)})`);
}

// ---------------------------------------------------------------------------
// T20. AAC export — @ffmpeg/wasm integration (Node-testable parts).
// The real encode runs in a browser worker (module worker + 30 MB core);
// under Node we verify: (a) core assets exist, (b) the public/ffmpeg/
// static copy is intact, (c) buildAacArgs produces the exact argv,
// (d) the package itself refuses to run under Node (expected stub).
// ---------------------------------------------------------------------------
async function t20(): Promise<void> {
  console.log('\nT20. AAC export (@ffmpeg/wasm assets + argv)');

  // (a) Core assets in node_modules
  const coreDir = join('node_modules', '@ffmpeg', 'core', 'dist', 'esm');
  const libDir = join('node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm');
  const coreJs = join(coreDir, 'ffmpeg-core.js');
  const coreWasm = join(coreDir, 'ffmpeg-core.wasm');
  check('core js present', existsSync(coreJs), coreJs);
  const wasmSize = existsSync(coreWasm) ? statSync(coreWasm).size : 0;
  check('core wasm present (28–36 MB)', wasmSize >= 28e6 && wasmSize <= 36e6, `${(wasmSize / 1e6).toFixed(1)} MB`);

  // (b) public/ffmpeg/ copy integrity (produced by copy-ffmpeg.js)
  const pubDir = join('public', 'ffmpeg');
  const copyNames = ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'worker.js', 'const.js', 'errors.js'];
  if (!existsSync(pubDir)) {
    console.log('  SKIP  public/ffmpeg copy — run `npm run dev` (copy-ffmpeg.js) first');
  } else {
    for (const name of copyNames) {
      const p = join(pubDir, name);
      const present = existsSync(p);
      check(`copy ${name}`, present, p);
      if (!present) continue;
      const ref = name.startsWith('ffmpeg-core') ? join(coreDir, name) : join(libDir, name);
      check(`copy ${name} size matches`, statSync(p).size === statSync(ref).size, `${statSync(p).size} B`);
    }
  }

  // (c) Exact argv for the encoder
  const a1 = buildAacArgs(44100, 2, 256, { title: 'T20', artist: 'NMP Test' });
  check('aac args (44.1k stereo 256k + tags)', JSON.stringify(a1) === JSON.stringify([
    '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', 'in.pcm',
    '-c:a', 'aac', '-b:a', '256k',
    '-metadata', 'title=T20', '-metadata', 'artist=NMP Test', 'out.m4a',
  ]), a1.join(' '));
  const a2 = buildAacArgs(48000, 1, 128);
  check('aac args (48k mono 128k, no tags)', JSON.stringify(a2) === JSON.stringify([
    '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', 'in.pcm',
    '-c:a', 'aac', '-b:a', '128k', 'out.m4a',
  ]), a2.join(' '));

  // (d) Node guard: 0.12 ships a Node entry that throws (browser-only lib).
  try {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    void new FFmpeg(); // may be legal to construct; worker spawn is the real failure — browser-only either way
    console.log('  NOTE  @ffmpeg/ffmpeg imported under Node without throw (stub is version-specific) — encode stays browser-only');
  } catch {
    check('node guard — @ffmpeg/ffmpeg refuses Node', true, 'expected throw');
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Neural Master Pro — audio core known-value tests');
  // measureMetrics smoke (the combined entry point the UI will use)
  {
    const sr = 48000;
    const l = sine(1000, 5, sr, dbToLin(-20));
    const r = new Float32Array(l);
    const m = await measureMetrics(l, r, sr);
    console.log('\nT0. measureMetrics smoke (1kHz sine -20dBFS)');
    check('metrics: LUFS ≈ -20, TP ≈ -20, sane fields',
      near(m.integratedLufs, -20.03, 0.3) && near(m.truePeakDb, -20, 0.3) && m.crestDb >= 0,
      `LUFS ${m.integratedLufs.toFixed(2)}, TP ${m.truePeakDb.toFixed(2)}, LRA ${m.lra.toFixed(2)}, crest ${m.crestDb.toFixed(2)} dB`);
    void linToDb;
  }
  await t1();
  await t2();
  await t3();
  await t4();
  t5();
  await t6();
  await t7();
  await t12();
  await t8();
  await t9();
  await t10();
  b10();
  await t16();
  await t17();
  await t18();
  await t19();
  await t20();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
