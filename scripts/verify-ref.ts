// Deterministic reference for the in-browser UI verification (Phase 1).
// Generates the SAME signal the in-page test injects (10 s stereo 48 kHz
// 1 kHz sine at -11 dBFS, 20 ms raised-cosine fades, 16-bit quantized) and
// measures it with the exact same audioMeters pipeline the app uses.
// Compare the printed numbers against the app's Track Analysis block
// (expect |dLUFS| <= 0.3, |dTP| <= 0.2 dB).
import { measureMetrics } from '../src/lib/audioMeters.ts';

const sr = 48000;
const dur = 10;
const n = sr * dur;
const L = new Float32Array(n);
const R = new Float32Array(n);
const amp = Math.pow(10, -11 / 20);
const fade = Math.floor(0.02 * sr);
for (let i = 0; i < n; i++) {
  let g = 1;
  if (i < fade) g = 0.5 * (1 - Math.cos((Math.PI * i) / fade));
  else if (i >= n - fade) g = 0.5 * (1 + Math.cos((Math.PI * (i - (n - fade))) / fade));
  const v = amp * Math.sin((2 * Math.PI * 1000 * i) / sr) * g;
  L[i] = v;
  R[i] = v;
}

// 16-bit quantization (the browser decodes a 16-bit WAV)
const q = (v: number) => {
  const s = Math.max(-1, Math.min(1, v));
  return Math.round(s * 32767) / 32767;
};
const Lq = L.map(q);
const Rq = R.map(q);

const m = await measureMetrics(Lq, Rq, sr);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
console.log('REF integratedLufs', r3(m.integratedLufs));
console.log('REF truePeakDb', r3(m.truePeakDb));
console.log('REF lra', r3(m.lra));
console.log('REF crestDb', r3(m.crestDb));
console.log('REF correlation', r3(m.correlation));
console.log('REF dcOffsetDb', m.dcOffsetDb);
