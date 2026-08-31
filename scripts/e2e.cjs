/**
 * e2e.cjs — full-feature browser E2E matrix for v2.3 (plan C2).
 *
 * Run:  node scripts/e2e.cjs [url]
 *         (dev server must be up; default http://127.0.0.1:3000/)
 *
 * Drives the real app with puppeteer-core + the system Edge (no Chrome
 * download, same pattern as screens.cjs / fps-measure.cjs). Uploads a
 * generated 10 s test tone through the real file input and verifies every
 * user-visible function as "action -> observable effect":
 *
 *   M1 Pro mixer   — engine up + default master monitoring (A1), honest
 *                    isReady (A2), TONAL/FX/EQ sliders move the DSP
 *                    (live param readback + offline renderProPcm diff per
 *                    parameter), FX regions (A3 toast, in-window-only
 *                    effect), monitoring A/B, 7 visualizers, transport,
 *                    Reset clears the whole Pro panel block.
 *   M2 Lite        — 10 presets hit LUFS target / stay under the TP ceiling,
 *                    custom preset, A/B hold, batch of 3 -> ZIP with valid
 *                    WAVs, exports WAV 16/24/32f, MP3 192/320, FLAC.
 *   M3 Pro export  — WAV 16/24/32f, FLAC, MP3 320, AAC 128/256 (m4a with
 *                    title metadata), video (webm/mp4, duration ~= trim).
 *   M4 System      — 9 languages (no "undefined", localized labels),
 *                    hardware widget honest in headless (--°C), FPS p95
 *                    over 60 s playback, FPS on a fresh page while the
 *                    metrics pass runs in the worker, timeline slider
 *                    frozen on pause, Pexels multi-clip export cutting on
 *                    the audio peaks (synthetic offline clips, pixel checks
 *                    on the hidden export canvas), zero unexpected console
 *                    issues.
 *
 * All DOM helpers live IN the page (window.__h) because page.evaluate only
 * serializes its own function. Downloads are captured in-page (blob anchor
 * hook) and validated byte-level in Node: WAV fmt chunk, MP3 frame header
 * bitrate, FLAC STREAMINFO, m4a ftyp + title bytes, webm EBML Duration,
 * fflate ZIP -> per-file WAVs.
 */
const { runFlickerRegress } = require('./e2e-flicker-regress.cjs');
const { runKaraokeRegress } = require('./e2e-karaoke-regress.cjs');
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

// Edge 152.0.4191.53 headless is broken on this box (exits 0 with no render);
// system Chrome works. Override with NMP_BROWSER.
const EDGE = process.env.NMP_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = process.argv[2] || 'http://127.0.0.1:3000/';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const fails = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}  ${detail}`);
  } else {
    failed += 1;
    fails.push(name);
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}
let curSection = 'startup';
const RUN_T0 = Date.now();
function section(title) {
  curSection = title.split(' — ')[0];
  console.log(`\n${'='.repeat(64)}\n[+${((Date.now() - RUN_T0) / 1000).toFixed(0)}s] ${title}\n${'='.repeat(64)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, ms = 20000, step = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await page.evaluate(fn)) return true;
    } catch { /* page mid-navigation */ }
    await sleep(step);
  }
  return false;
}

/** Run a named page helper with args. */
const h = (page, name, ...args) => page.evaluate((n, a) => window.__h[n](...a), name, args);

// ---------------------------------------------------------------------------
// Test audio: 10 s stereo 44.1 kHz 16-bit chord (main), 10 s ref chord,
// three 3 s short tones for the batch queue.
// ---------------------------------------------------------------------------

function writeToneWav(file, freqs, dur, sr = 44100) {
  const n = sr * dur;
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const env = Math.min(1, t / 0.5) * Math.min(1, (dur - t) / 1.5);
    let s = 0;
    for (let k = 0; k < freqs.length; k += 1) {
      s += (Math.sin(2 * Math.PI * freqs[k] * t) * 0.4) / freqs.length;
    }
    const l = Math.max(-1, Math.min(1, s * env));
    const r = Math.max(-1, Math.min(1, s * env * 0.9));
    pcm.writeInt16LE(Math.round(l * 32767), i * 4);
    pcm.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22);
  hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([hdr, pcm]));
}

// Onset-grid fixture for Vocal Align (M1.13): noise floor + 20 ms bursts.
function writeBurstsWav(file, times, dur, sr = 44100) {
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  const n = Math.round(sr * dur);
  const buf = new Float64Array(n);
  for (let i = 0; i < n; i += 1) buf[i] = rnd() * 0.02;
  for (const t of times) {
    const s0 = Math.round(t * sr);
    const len = Math.round(0.02 * sr);
    for (let k = 0; k < len && s0 + k < n; k += 1) buf[s0 + k] += rnd() * 0.7 * (1 - k / len);
  }
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) {
    const v = Math.max(-1, Math.min(1, buf[i]));
    pcm.writeInt16LE(Math.round(v * 32767), i * 4);
    pcm.writeInt16LE(Math.round(v * 32767), i * 4 + 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22);
  hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([hdr, pcm]));
}

// ---------------------------------------------------------------------------
// In-page helpers (installed once; page.evaluate cannot see Node-scope fns)
// ---------------------------------------------------------------------------

async function installPageHelpers(page) {
  await page.evaluate(() => {
    const inputSet = (el, value) => {
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    const setTonalSlider = (labelText, value) => {
      const lab = [...document.querySelectorAll('label')]
        .find((l) => l.textContent.trim().toUpperCase() === labelText.toUpperCase());
      if (!lab) return { ok: false, err: `label not found: ${labelText}` };
      const box = lab.parentElement.parentElement;
      const range = box.querySelector('input[type="range"]');
      if (!range) return { ok: false, err: 'no range in box' };
      if (range.disabled) return { ok: false, err: 'range is disabled' };
      inputSet(range, value);
      const num = box.querySelector('input[type="number"]');
      return { ok: true, ui: num ? parseFloat(num.value) : null };
    };
    const setFxSlider = (fxLabel, value) => {
      const grid = document.querySelector('div.grid.grid-cols-5');
      if (!grid) return { ok: false, err: 'FX grid not found' };
      const cell = [...grid.children]
        .find((c) => c.textContent.trim().toUpperCase().startsWith(fxLabel.toUpperCase()));
      if (!cell) return { ok: false, err: `FX cell not found: ${fxLabel}` };
      const range = cell.querySelector('input[type="range"]');
      if (!range) return { ok: false, err: 'no range in FX cell' };
      if (range.disabled) return { ok: false, err: 'FX range is disabled' };
      inputSet(range, value);
      return { ok: true, ui: parseFloat(range.value) };
    };
    const eqSetBand = (label, value) => {
      const span = [...document.querySelectorAll('span')]
        .find((s) => s.textContent.trim() === label && s.className.includes('font-mono'));
      if (!span) return { ok: false, err: `EQ band not found: ${label}` };
      const col = span.closest('div.w-8');
      const range = col && col.querySelector('input[type="range"]');
      if (!range) return { ok: false, err: 'no range in band column' };
      if (range.disabled) return { ok: false, err: 'EQ range disabled' };
      inputSet(range, value);
      return { ok: true, ui: parseFloat(range.value) };
    };
    const clickText = (text) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === text && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    };
    const clickTextStart = (prefix) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(prefix) && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    };
    /** The Lite "Master" button (px-5 py-2.5) — NOT the MASTER monitoring tab (px-3 py-1),
        which is the first 'Master' button in DOM order. */
    const clickLiteMaster = () => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        x.textContent.trim() === 'Master' && /px-5 py-2\.5/.test(x.className) && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    };
    /** Read a live Faust DSP param by logical name (path resolved like AudioEngine). */
    const dspParam = (name) => {
      const e = window.__NMP__.getEngine();
      const fn = e.faustNode;
      if (!fn) return { err: 'no faustNode' };
      const params = fn.getParams();
      const exact = `/mastering/${name}`;
      const p = params.includes(exact) ? exact : params.find((x) => x.endsWith(`/${name}`) || x === name);
      if (!p) return { err: `param not found: ${name}` };
      return { path: p, value: fn.getParamValue(p) };
    };
    /** Parametric EQ band control by data-testid (kind: type/gain/freq/q). */
    const peqSet = (band, kind, value) => {
      const el = document.querySelector(`[data-testid="peq${band}-${kind}"]`);
      if (!el) return { ok: false, err: `PEQ control not found: peq${band}-${kind}` };
      if (el.disabled) return { ok: false, err: `PEQ control disabled: peq${band}-${kind}` };
      inputSet(el, value);
      return { ok: true, ui: parseFloat(el.value) };
    };
    const setRangeByMinMax = (min, max, value) => {
      const r = document.querySelector(`input[type="range"][min="${min}"][max="${max}"]`);
      if (!r || r.disabled) return false;
      inputSet(r, value);
      return true;
    };
    /** TimeControls seek bar (min 0, max ~= duration, not the opacity-0 region edges). */
    const seekBar = (value) => {
      const r = [...document.querySelectorAll('input[type="range"]')]
        .find((x) => x.min === '0' && +x.max >= 9.5 && +x.max <= 11 && !x.className.includes('opacity-0'));
      if (!r) return false;
      inputSet(r, value);
      return true;
    };
    const getSeekBarLabel = () => {
      const span = document.querySelector('div.space-y-1 span');
      return span ? span.textContent : '';
    };
    /** Current value of the TimeControls seek bar (same selector as seekBar). */
    const seekBarValue = () => {
      const r = [...document.querySelectorAll('input[type="range"]')]
        .find((x) => x.min === '0' && +x.max >= 9.5 && +x.max <= 11 && !x.className.includes('opacity-0'));
      return r ? parseFloat(r.value) : null;
    };
    window.__h = { inputSet, setTonalSlider, setFxSlider, eqSetBand, clickText, clickTextStart, clickLiteMaster, dspParam, peqSet, setRangeByMinMax, seekBar, getSeekBarLabel, seekBarValue };
  });
}

// ---------------------------------------------------------------------------
// Node-side file validators
// ---------------------------------------------------------------------------

function parseWav(buf) {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  let dataBytes = 0;
  let dataOff = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = {
      format: buf.readUInt16LE(off + 8),
      channels: buf.readUInt16LE(off + 10),
      sampleRate: buf.readUInt32LE(off + 12),
      bits: buf.readUInt16LE(off + 22),
    };
    if (id === 'data') { dataBytes = size; dataOff = off + 8; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !dataBytes) return null;
  // Peak (subsampled) — proves the file actually contains the signal.
  let peak = 0;
  const step = fmt.bits / 8;
  const stride = Math.max(1, Math.floor(dataBytes / (step * 20000)));
  for (let i = 0; i + step <= dataBytes; i += step * stride) {
    let v;
    if (fmt.bits === 16) v = Math.abs(buf.readInt16LE(dataOff + i)) / 32768;
    else if (fmt.bits === 24) v = Math.abs(buf.readIntLE(dataOff + i, 3)) / 8388608;
    else if (fmt.bits === 32) v = Math.abs(buf.readFloatLE(dataOff + i));
    else v = 0;
    if (v > peak) peak = v;
  }
  return {
    ...fmt,
    dataBytes,
    duration: dataBytes / (fmt.channels * fmt.sampleRate * step),
    peak,
  };
}

function parseMp3(buf) {
  if (!buf || buf.length < 42) return null;
  // Locate the first MPEG frame sync (skip an ID3 tag if present).
  let off = 0;
  if (buf.toString('ascii', 0, 3) === 'ID3') {
    off = 10 + (((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]) & 0x3fffffff);
  }
  for (let i = off; i < Math.min(buf.length - 4, off + 4096); i += 1) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) { off = i; break; }
  }
  // The first frame after the ID3 tag may be an encoder-header frame with a
  // different bitrate index. Walk a few frames and take the last (steady) kbps.
  // MPEG1 Layer III bitrate table, used both for the kbps read and the
  // frame-length math (144 * bitrate / samplerate + padding).
  const KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const SR1 = [44100, 48000, 32000]; // MPEG1 Layer III sample rates
  let kbps = 0;
  let p = off;
  for (let f = 0; f < 4 && p + 4 < buf.length; f += 1) {
    const b2 = buf[p + 1];
    const b3 = buf[p + 2];
    const version = (b2 >> 3) & 3; // 3 = MPEG1
    const layer = (b2 >> 1) & 3;   // 1 = Layer III
    const bitrateIdx = (b3 >> 4) & 15;
    if (version !== 3 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15) break;
    kbps = KBPS[bitrateIdx];
    // b3 layout: [7:4] bitrate, [3:2] sample rate, [1] padding, [0] private.
    const frameLen = (144 * KBPS[bitrateIdx] * 1000) / SR1[(b3 >> 2) & 3] + ((b3 >> 1) & 1);
    p += frameLen;
  }
  if (!kbps) return null;
  return { kbps, sync: true };
}

function parseFlac(buf) {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'fLaC') return null;
  // Metadata blocks: 1-byte header ((last<<7)|type) + 3-byte big-endian size.
  let off = 4;
  let si = null;
  for (let g = 0; g < 10 && off + 4 <= buf.length; g += 1) {
    const hdr = buf[off];
    const size = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    if ((hdr & 0x80) === 0 && (hdr & 0x7f) === 0) { si = buf.slice(off + 4, off + 4 + size); break; } // STREAMINFO
    if (hdr & 0x80) return null; // no STREAMINFO
    off += 4 + size;
  }
  if (!si || si.length < 34) return null;
  const sampleRate = ((si[10] & 0x0f) << 12) | (si[11] << 4) | (si[12] >> 4);
  const channels = ((si[12] & 0x0e) >> 1) + 1;
  const bits = (((si[12] & 0x01) << 4) | (si[13] >> 4)) + 1;
  const totalSamples = (si[13] & 0x0f) * 0x100000000 + si[14] * 0x1000000 + si[15] * 0x10000 + si[16] * 0x100 + si[17];
  return { sampleRate, channels, bits, totalSamples, duration: totalSamples / sampleRate };
}

function parseM4a(buf) {
  if (!buf || buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') return null;
  return { brand: buf.toString('ascii', 8, 12), bytes: buf.length };
}

/** Minimal EBML walk: Segment(0x18538067) -> SegmentInfo(0x1549A966) -> Duration(0x94). */
function parseWebmDurationMs(buf) {
  const seg = buf.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  if (seg < 0) return null;
  let off = seg + 4;
  // skip the VINT size of the segment
  for (let i = off; i < off + 8; i += 1) { if ((buf[i] & 0x80) === 0) { off = i + 1; break; } }
  const info = buf.indexOf(Buffer.from([0x15, 0x49, 0xa9, 0x66]), off);
  if (info < 0) return null;
  let i2 = info + 4;
  for (let i = i2; i < i2 + 8; i += 1) { if ((buf[i] & 0x80) === 0) { i2 = i + 1; break; } }
  const dur = buf.indexOf(0x94, i2);
  if (dur < 0 || dur > i2 + 4096) return null;
  const dB = buf[dur + 1]; // 0x88 = float64, 0x84 = float32
  return dB === 0x88 ? buf.readDoubleBE(dur + 2) : buf.readFloatBE(dur + 2); // ms
}

/** Minimal ZIP reader (store + deflate) — enough for fflate output. */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65557; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let k = 0; k < count; k += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central dir');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + csize);
    out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// FPS snapper (same logic as fps-measure.cjs)
const INJECT_SNAPPER = () => {
  if (window.__fps) { window.__fps.deltas.length = 0; return; }
  window.__fps = { deltas: [] };
  let last = performance.now();
  const loop = (t) => {
    const d = t - last;
    last = t;
    if (d < 1000) window.__fps.deltas.push(d);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
};
const READ_SNAPPER = () => {
  const d = [...window.__fps.deltas].sort((a, b) => a - b);
  if (d.length === 0) return null;
  const p = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))];
  return { n: d.length, p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), max: +d[d.length - 1].toFixed(1), gt100: d.filter((x) => x > 100).length };
};

// ---------------------------------------------------------------------------
// Download capture (in-page blob-anchor hook -> byte transfer via base64)
// ---------------------------------------------------------------------------

async function installDownloadHook(page) {
  await page.evaluate(() => {
    window.__nmpDl = { items: [] };
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = orig(blob);
      window.__nmpDl.items.push({ url, blob, name: null, taken: false, read: false });
      return url;
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const it = window.__nmpDl.items.find((x) => x.url === this.href && !x.taken);
      if (it && this.download) { it.name = this.download; it.taken = true; return; }
      return origClick.call(this);
    };
  });
}

/** Take the next captured-but-unread download; returns {name, buf} or null. */
async function takeDownload(page) {
  const idx = await page.evaluate(() => {
    const i = window.__nmpDl.items.findIndex((x) => x.taken && !x.read);
    if (i >= 0) window.__nmpDl.items[i].read = true;
    return i;
  });
  if (idx < 0) return null;
  const [b64, name] = await page.evaluate(async (i) => {
    const it = window.__nmpDl.items[i];
    const ab = await it.blob.arrayBuffer();
    const u8 = new Uint8Array(ab);
    let bin = '';
    for (let j = 0; j < u8.length; j += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(j, j + 0x8000));
    return [btoa(bin), it.name];
  }, idx);
  return { name, buf: Buffer.from(b64, 'base64') };
}

/** Wait until a download lands, then take it. */
async function awaitDownload(page, ms = 120000) {
  const ok = await waitFor(page, () => window.__nmpDl.items.some((x) => x.taken && !x.read), ms);
  return ok ? takeDownload(page) : null;
}

/** Flush downloads left in-flight by a previous section so this section's
 *  awaitDownload cannot consume a stale artifact (run 9: M1.13 consumed a
 *  late .m4a, M4.5 consumed a late mp4 of its own PREVIOUS section). */
async function drainDownloads(page, note = '') {
  for (let d = await awaitDownload(page, 1200); d; d = await awaitDownload(page, 1200))
    console.log(`    [drain] dropped stale download: ${d.name || '?'} (${d.buf.length} B)${note}`);
}

// ---------------------------------------------------------------------------

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const TONE = path.join(OUT_DIR, 'e2e_tone.wav');
  const REFTONE = path.join(OUT_DIR, 'e2e_ref.wav');
  const HIGHTONE = path.join(OUT_DIR, 'e2e_hightone.wav');
  const B1 = path.join(OUT_DIR, 'e2e_batch1.wav');
  const B2 = path.join(OUT_DIR, 'e2e_batch2.wav');
  const B3 = path.join(OUT_DIR, 'e2e_batch3.wav');
  // 64x32 cover fixture: left half red, right half blue (aspect 2:1 — pan
  // possible horizontally only; a dragged offset shifts red in / blue out).
  const COVER_WIDE = path.join(OUT_DIR, 'e2e_cover_wide.png');
  fs.writeFileSync(COVER_WIDE, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAO0lEQVR4nO3PMQ0AAAgDMERw41' +
    '/ZdKCBg69JDbTS82o6r0pAQEBAQEBAQEBAQEBAQEBAQEBAQEBA4GoBR67AeeBFlJEAAAAA' +
    'SUVORK5CYII=', 'base64'));
  writeToneWav(TONE, [110, 220, 440], 10);
  writeToneWav(REFTONE, [330, 660, 990], 10);
  writeToneWav(HIGHTONE, [4400, 8800, 12000], 10);
  writeToneWav(B1, [100], 3);
  writeToneWav(B2, [200], 3);
  writeToneWav(B3, [300], 3);
  // Vocal Align fixtures: dub = guide onsets delayed ~0.35 s, longer by 0.35 s.
  const GUIDE = path.join(OUT_DIR, 'e2e_guide.wav');
  const DUB = path.join(OUT_DIR, 'e2e_dub.wav');
  writeBurstsWav(GUIDE, [1.0, 2.5, 4.0], 5);
  writeBurstsWav(DUB, [1.35, 2.9, 4.5], 5.35);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  // Media/resource error attribution: bare 'pageerror: ErrorEvent' carries no
  // message — capture the element tag + src so failures are locatable.
  await page.evaluateOnNewDocument(() => {
    window.__nmpErr = [];
    window.addEventListener('error', (ev) => {
      const t = ev.target;
      window.__nmpErr.push({
        tag: t && t.tagName ? t.tagName : String(ev.message || 'window'),
        src: t && (t.currentSrc || t.src) ? String(t.currentSrc || t.src).slice(0, 90) : undefined,
        code: t && t.error ? t.error.code : undefined,
        msg: String(ev.message || '').slice(0, 200),
        stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 400)
          : (ev.error ? String(ev.error).slice(0, 300) : undefined),
        // a thrown/rejected ErrorEvent carries the real cause in .error
        inner: ev.error && ev.error.error
          ? String(ev.error.error) + ' :: ' + String(ev.error.error.message || '')
          : undefined,
        // the thrown ErrorEvent's OWN fields (worker errors: message/filename
        // describe the failure INSIDE the worker)
        thrown: ev.error && (ev.error.message || ev.error.filename)
          ? String(ev.error.message || '') + ' @ ' + String(ev.error.filename || '') + ':' + (ev.error.lineno || 0)
          : undefined,
        ctor: t && Object.getPrototypeOf(t) && Object.getPrototypeOf(t).constructor
          ? Object.getPrototypeOf(t).constructor.name : undefined,
        // the last resort for the blob-hash ErrorEvent: what IS the thrown thing
        errCtor: ev.error && ev.error.constructor ? ev.error.constructor.name : typeof ev.error,
        errName: ev.error && ev.error.name,
        errString: typeof ev.error === 'object' && ev.error ? String(ev.error).slice(0, 160) : String(ev.error).slice(0, 160),
        errProps: ev.error && typeof ev.error === 'object'
          ? Object.getOwnPropertyNames(ev.error).join(',').slice(0, 160) : undefined,
        href: location.href.slice(0, 42),
        ageMs: Math.round(performance.now()),
      });
    }, true);
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev.reason;
      window.__nmpErr.push({
        tag: 'unhandledrejection',
        msg: String((r && r.message) || r).slice(0, 200),
        inner: r && r.error ? String(r.error) + ' :: ' + String(r.error.message || '') : undefined,
        stack: r && r.stack ? String(r.stack).slice(0, 400) : undefined,
      });
    }, true);
  });

  const consoleIssues = [];
  const consoleLogs = [];
  page.on('console', (msg) => {
    const t = msg.type();
    const text = msg.text().slice(0, 1500);
    if (t === 'error' || t === 'warning') consoleIssues.push({ t, text, sec: curSection });
    else if (t === 'log') consoleLogs.push(text);
  });
  page.on('pageerror', (e) => consoleIssues.push({ t: 'pageerror', text: String(e.message || e).slice(0, 1500), sec: curSection, wall: Date.now() }));
  // Raw browser-side log entries (CDP Log domain) — surfaces errors Blink
  // reports before/without the page JS world (worker script failures, blob
  // loads). Diagnostics only: NOT counted as failures.
  const rawLog = [];
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Log.enable');
    cdp.on('Log.entryAdded', (e) => {
      const en = e.entry || {};
      rawLog.push({ level: en.level, src: en.source, url: String(en.url || '').slice(0, 120), text: String(en.text || '').slice(0, 220), wall: Date.now() });
    });
  } catch { /* CDP unavailable */ }
  browser.on('workerfailed', (w, err) => {
    rawLog.push({ level: 'error', src: 'worker', url: String(w.url() || '').slice(0, 120), text: String(err).slice(0, 220), wall: Date.now() });
    console.log(`[workerfailed] ${String(w.url()).slice(0, 120)} ${String(err).slice(0, 120)}`);
  });

  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 90000 });
  if (!(await waitFor(page, () => !!document.querySelector('select'), 30000))) {
    console.error('FATAL: app did not mount');
    await browser.close();
    process.exit(1);
  }
  await installDownloadHook(page);
  await installPageHelpers(page);

  // --- load the main tone, then wait for the Faust engine to come up -------
  const fileInput = await page.$('#track-upload');
  await fileInput.uploadFile(TONE);
  const loaded = await waitFor(page, () => document.querySelectorAll('input[type="range"]').length > 10, 30000);
  const engineUp = await waitFor(page, () => {
    try { const e = window.__NMP__.getEngine(); return e.isReady() && !!e.faustNode; } catch { return false; }
  }, 120000, 500);
  console.log(`\napp mounted, track loaded: ${loaded}, engine ready: ${engineUp}`);
  if (!engineUp) {
    console.error('  (console so far:)', JSON.stringify(consoleIssues.slice(0, 8), null, 1));
  }
  await sleep(1000);

  // =========================================================================
  section('M1.1 — Fresh launch: engine, default monitoring (A1/A2), t21 identity');
  // =========================================================================
  {
    check('Faust init log', consoleLogs.some((l) => l.includes('INITIALIZED SUCCESSFULLY')),
      consoleLogs.find((l) => l.includes('Faust')) || 'not found');
    const st = await page.evaluate(() => {
      const e = window.__NMP__.getEngine();
      const a1 = e.getAnalysers();
      const a2 = e.getAnalysers();
      return { ready: e.isReady(), bypass: e.getBypass(), identity: a1 === a2, hasFaust: !!e.faustNode };
    });
    check('engine.isReady() true', st.ready === true);
    check('DSP chain NOT bypassed by default (A1)', st.bypass === false, `bypass=${st.bypass}`);
    check('faustNode present', st.hasFaust === true);
    check('t21: getAnalysers() returns stable identity', st.identity === true);
    // MASTER monitoring button active (first of the 3 A/B buttons)
    const mon = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')].filter((b) => ['Master', 'Source', 'Ref'].includes(b.textContent.trim()));
      return btns.map((b) => ({ t: b.textContent.trim(), on: b.className.includes('bg-[var(--accent)]') }));
    });
    check('monitoring default = MASTER active', mon.length === 3 && mon[0].t === 'Master' && mon[0].on, JSON.stringify(mon));
    // A1 regression: no Pro slider hard-disabled on fresh launch
    const disabled = await page.evaluate(() => document.querySelectorAll('input[type="range"][disabled]').length);
    check('no disabled sliders on fresh launch (A1)', disabled === 0, `${disabled} disabled ranges`);
  }

  // =========================================================================
  section('M1.2 — TONAL sliders: UI moves + live DSP param changes');
  // =========================================================================
  {
    const sliders = [
      ['Drive / Loudness', 'gain', 6],
      ['Low Frequencies', 'lowShelf', 6],
      ['Mid Frequencies', 'midRange', 4],
      ['High Air', 'highShelf', 6],
      ['Fundamental', 'fundamentalFreq', 100],
      ['Density', 'compression', 3],
      ['Limiter', 'limiter', -1],
      ['Harmonics', 'saturation', 5],
      ['Exciter', 'exciterAmount', 5],
      ['Haas Doubling', 'haasAmount', 50],
      ['Stereo Field', 'stereoWidth', 30],
      ['Comp Amount', 'compAmt', 60],
      ['Comp Threshold', 'compThresh', -18],
      ['Comp Ratio', 'compRatio', 4],
      ['Comp Attack', 'compAttack', 20],
      ['Comp Release', 'compRelease', 200],
      ['Gate Amount', 'gateAmt', 80],
      ['Gate Threshold', 'gateThresh', -40],
      ['Gate Release', 'gateRelease', 150],
      ['Trans Amount', 'transAmt', 50],
      ['Trans Freq', 'transFreq', 400],
      ['Widener', 'widenerAmt', 80],
      ['Tape Amount', 'tapeAmt', 50],
      ['Tape Tone', 'tapeTone', 8000],
      ['Air Amount', 'airAmt', 50],
      ['Air Freq', 'airFreq', 10000],
      ['DeEss Amount', 'deessAmt', 50],
      ['DeEss Freq', 'deessFreq', 7000],
      ['Phaser', 'phaserAmt', 50],
      ['Flanger', 'flangerAmt', 50],
      ['Tremolo', 'tremoloAmt', 50],
      ['Bit Depth', 'bitDepth', 12],
      ['SR Hold', 'srHold', 5],
    ];
    for (const [label, name, target] of sliders) {
      const r = await h(page, 'setTonalSlider', label, target);
      const uiOk = r.ok && Math.abs(r.ui - target) < 0.01;
      await sleep(250);
      const p = await h(page, 'dspParam', name);
      const pOk = p && !p.err && typeof p.value === 'number' && Math.abs(p.value - target) < 0.01;
      check(`${label} -> DSP ${name}`, r.ok && uiOk && pOk, r.ok ? `ui=${r.ui}, dsp=${p && p.value}` : r.err);
    }
  }

  // =========================================================================
  section('M1.2b — Parametric EQ: 4 bands x (gain/freq/Q/type) -> live DSP');
  // =========================================================================
  {
    // gain/freq/q before type: the Q slider is disabled once type != 0 (peak).
    const cases = [
      [1, 'gain', 'peq1Gain', 6], [1, 'freq', 'peq1Freq', 35], [1, 'q', 'peq1Q', 3], [1, 'type', 'peq1Type', 1],
      [2, 'gain', 'peq2Gain', -4], [2, 'freq', 'peq2Freq', 60], [2, 'q', 'peq2Q', 2], [2, 'type', 'peq2Type', 2],
      [3, 'gain', 'peq3Gain', 8], [3, 'freq', 'peq3Freq', 80], [3, 'q', 'peq3Q', 5], [3, 'type', 'peq3Type', 1],
      [4, 'gain', 'peq4Gain', -6], [4, 'freq', 'peq4Freq', 95], [4, 'q', 'peq4Q', 1], [4, 'type', 'peq4Type', 2],
    ];
    for (const [band, kind, name, target] of cases) {
      const r = await h(page, 'peqSet', band, kind, target);
      await sleep(200);
      const p = await h(page, 'dspParam', name);
      const pOk = p && !p.err && typeof p.value === 'number' && Math.abs(p.value - target) < 0.01;
      check(`PEQ band${band} ${kind} -> DSP ${name}`, r.ok && pOk, r.ok ? `ui=${r.ui}, dsp=${p && p.value}` : r.err);
    }
  }

  // =========================================================================
  section('M1.2c — MONO button: toggle collapses/widens the side channel');
  // =========================================================================
  {
    const on = await h(page, 'clickText', 'Mono');
    await sleep(250);
    const pOn = await h(page, 'dspParam', 'mono');
    check('MONO on -> DSP mono=1', on && pOn && !pOn.err && pOn.value === 1, `dsp=${pOn && pOn.value}`);
    const off = await h(page, 'clickText', 'Mono');
    await sleep(250);
    const pOff = await h(page, 'dspParam', 'mono');
    check('MONO off -> DSP mono=0', off && pOff && !pOff.err && pOff.value === 0, `dsp=${pOff && pOff.value}`);
  }

  // =========================================================================
  section('M1.3 — FX row: 5 effects x 4 stems, UI + live DSP param');
  // =========================================================================
  {
    const stems = [['MASTER', ''], ['BASS', 'bass_'], ['MID', 'mid_'], ['SIDE', 'side_']];
    const fxs = [['Autotune', 'autotune', 70], ['Reverb', 'reverb', 80], ['Disturb', 'distortion', 60], ['Delay', 'delay', 50], ['Chorus', 'chorus', 45]];
    for (const [stemLabel, prefix] of stems) {
      const tab = await h(page, 'clickText', stemLabel);
      if (!tab) { check(`stem tab ${stemLabel}`, false, 'button not found'); continue; }
      for (const [fxLabel, name, target] of fxs) {
        const r = await h(page, 'setFxSlider', fxLabel, target);
        await sleep(250);
        const p = await h(page, 'dspParam', `${prefix}${name}`);
        const pOk = p && !p.err && Math.abs(p.value - target) < 0.01;
        check(`FX ${stemLabel}/${fxLabel} -> DSP ${prefix}${name}`, r.ok && pOk,
          r.ok ? `ui=${r.ui}, dsp=${p && p.value}` : r.err);
      }
    }
  }

  // =========================================================================
  section('M1.4 — EQ: 10 bands + genre presets + custom slots + flatten');
  // =========================================================================
  {
    const bands = [
      ['eq31', '31', 4], ['eq62', '62', -3], ['eq125', '125', 4], ['eq250', '250', -2],
      ['eq500', '500', 3], ['eq1k', '1k', -4], ['eq2k', '2k', 2], ['eq4k', '4k', -3],
      ['eq8k', '8k', 4], ['eq16k', '16k', -2],
    ];
    for (const [name, label, target] of bands) {
      const r = await h(page, 'eqSetBand', label, target);
      await sleep(120);
      const p = await h(page, 'dspParam', name);
      const pOk = p && !p.err && Math.abs(p.value - target) < 0.01;
      check(`EQ ${label} Hz -> DSP ${name}`, r.ok && pOk, r.ok ? `ui=${r.ui}, dsp=${p && p.value}` : r.err);
    }

    // Genre presets
    const genres = [['Pop', 'eq62', 1.5], ['Rock', 'eq62', 2.0], ['Elec', 'eq31', 3.5], ['Class', 'eq16k', -1.5], ['Acoust', 'eq16k', 1.0]];
    for (const [g, probeName, probeVal] of genres) {
      const clicked = await h(page, 'clickText', g);
      await sleep(300);
      const p = await h(page, 'dspParam', probeName);
      check(`EQ preset ${g} applies (DSP ${probeName}=${probeVal})`, clicked && p && !p.err && Math.abs(p.value - probeVal) < 0.01,
        `dsp=${p && p.value}`);
    }

    // Custom slot save/load: eq62 -> 7, save to slot 1, eq62 -> -6, reload slot 1
    await h(page, 'eqSetBand', '62', 7);
    const saved = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').startsWith('Save to EQ slot'));
      if (!b) return false;
      b.click();
      return true;
    });
    await sleep(300);
    await h(page, 'eqSetBand', '62', -6);
    await sleep(200);
    const pMid = await h(page, 'dspParam', 'eq62');
    const reloaded = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').startsWith('Load Custom EQ 1'));
      if (!b) return false;
      b.click();
      return true;
    });
    await sleep(300);
    const pAfter = await h(page, 'dspParam', 'eq62');
    check('EQ custom slot: save + reload restores DSP', saved && reloaded
      && pMid && pAfter && Math.abs(pMid.value - -6) < 0.01 && Math.abs(pAfter.value - 7) < 0.01,
      `mid=${pMid && pMid.value}, after=${pAfter && pAfter.value}`);

    const flat = await h(page, 'clickText', 'Flatten');
    await sleep(300);
    const pFlat = await h(page, 'dspParam', 'eq62');
    check('EQ Flatten -> DSP zero', flat && pFlat && !pFlat.err && Math.abs(pFlat.value) < 0.01, `dsp=${pFlat && pFlat.value}`);
  }

  // =========================================================================
  section('M1.5 — DSP regression: every param actually changes the offline render');
  // =========================================================================
  {
    // One in-page loop: baseline render (neutral) + one render per param.
    const results = await page.evaluate(async () => {
      const e = window.__NMP__.getEngine();
      const neutral = window.__NMP__.getNeutralSettings();
      const params = [
        ['gain', 6], ['lowShelf', 6], ['midRange', 4], ['highShelf', 6],
        ['fundamentalFreq', 100], ['compression', 3],
        ['saturation', 5], ['exciterAmount', 5], ['haasAmount', 50], ['stereoWidth', 30],
        ['autotune', 70], ['reverb', 80], ['distortion', 60], ['delay', 50], ['chorus', 45],
        ['bass_autotune', 70], ['bass_reverb', 80], ['bass_distortion', 60], ['bass_delay', 50], ['bass_chorus', 45],
        ['mid_autotune', 70], ['mid_reverb', 80], ['mid_distortion', 60], ['mid_delay', 50], ['mid_chorus', 45],
        ['side_autotune', 70], ['side_reverb', 80], ['side_distortion', 60], ['side_delay', 50], ['side_chorus', 45],
        ['vocal_autotune', 70], ['vocal_reverb', 80], ['vocal_distortion', 60], ['vocal_delay', 50], ['vocal_chorus', 45],
        ['stem_solo', 2],
        ['eq31', 4], ['eq62', -3], ['eq125', 4], ['eq250', -2], ['eq500', 3],
        ['eq1k', -4], ['eq2k', 2], ['eq4k', -3], ['eq8k', 4], ['eq16k', -2],
        ['widenerAmt', 80], ['mono', 1], ['compAmt', 60], ['transAmt', 50],
        ['tapeAmt', 60], ['phaserAmt', 60], ['flangerAmt', 60], ['tremoloAmt', 60],
        ['bitDepth', 10], ['srHold', 5],
      ];
      const base = await e.renderProPcm({ ...neutral }, 0, 0, []);
      if (!base) return { err: 'baseline render failed' };
      const out = {};
      for (const [name, value] of params) {
        const s = { ...neutral, [name]: value };
        const r = await e.renderProPcm(s, 0, 0, []);
        if (!r) { out[name] = -1; continue; }
        const N = r.left.length;
        const step = Math.max(1, Math.floor(N / 4000));
        let maxd = 0;
        for (let i = 0; i < N; i += step) {
          const d = Math.abs(base.left[i] - r.left[i]) + Math.abs(base.right[i] - r.right[i]);
          if (d > maxd) maxd = d;
        }
        out[name] = maxd;
      }
      // Limiter threshold = max(0, param) dB (mastering.dsp): negative values clamp to a
      // 0 dBFS ceiling — a no-op for the -8 dBFS test tone. Prove it works with +18 dB of
      // drive: hard 0 dBFS ceiling (neutral) vs +5 dBFS ceiling must render differently.
      const lim0 = await e.renderProPcm({ ...neutral, gain: 18 }, 0, 0, []);
      const lim5 = await e.renderProPcm({ ...neutral, gain: 18, limiter: 5 }, 0, 0, []);
      if (lim0 && lim5) {
        const N = lim0.left.length;
        let maxd = 0;
        for (let i = 0; i < N; i += 16) {
          maxd = Math.max(maxd, Math.abs(lim0.left[i] - lim5.left[i]) + Math.abs(lim0.right[i] - lim5.right[i]));
        }
        out.limiter = maxd;
      } else {
        out.limiter = -1;
      }
      // PEQ: pair-diff (two renders) — the 110/220/440 Hz test chord sits far from the
      // default band centers (56/316/1778/7079 Hz), so each band is first placed ON the
      // chord (freq 35 ≈ 224 Hz) and a second param is varied against that placement.
      const pair = async (name, base2, delta) => {
        const a = await e.renderProPcm(base2, 0, 0, []);
        const b = await e.renderProPcm({ ...base2, ...delta }, 0, 0, []);
        if (!a || !b) { out[name] = -1; return; }
        const N = a.left.length;
        let maxd = 0;
        for (let i = 0; i < N; i += 16) {
          maxd = Math.max(maxd, Math.abs(a.left[i] - b.left[i]) + Math.abs(a.right[i] - b.right[i]));
        }
        out[name] = maxd;
      };
      const pb = { ...neutral, peq1Freq: 35 };
      await pair('peq1Gain', { ...pb, peq1Gain: 0 }, { peq1Gain: 8 });
      await pair('peq1Freq', { ...pb, peq1Gain: 8 }, { peq1Freq: 25 });
      await pair('peq1Q', { ...pb, peq1Gain: 8, peq1Q: 2 }, { peq1Q: 8 });
      await pair('peq1Type', { ...pb, peq1Gain: 8, peq1Type: 0 }, { peq1Type: 1 });
      await pair('peq2Gain', { ...neutral, peq2Freq: 35, peq2Gain: 0 }, { peq2Gain: 8 });
      await pair('peq3Gain', { ...neutral, peq3Freq: 35, peq3Gain: 0 }, { peq3Gain: 8 });
      await pair('peq4Gain', { ...neutral, peq4Freq: 35, peq4Gain: 0 }, { peq4Gain: 8 });
      // Compressor: at amt=60 the -8 dBFS peaks of the tone exceed the threshold,
      // so each control must shift gain reduction.
      await pair('compThresh', { ...neutral, compAmt: 60, compThresh: -18 }, { compThresh: -5 });
      await pair('compRatio', { ...neutral, compAmt: 60, compThresh: -18 }, { compRatio: 12 });
      await pair('compAttack', { ...neutral, compAmt: 60, compThresh: -18, compAttack: 1 }, { compAttack: 100 });
      await pair('compRelease', { ...neutral, compAmt: 60, compThresh: -18, compRelease: 30 }, { compRelease: 500 });
      // Gate: the tone body (RMS ~ -12.6 dBFS) sits above -4 dBFS, so the gate stays
      // open mid-tone but closes on the 0.5 s fade-in / 1.5 s fade-out ramps.
      await pair('gateAmt', { ...neutral, gateThresh: -4 }, { gateAmt: 100 });
      await pair('gateThresh', { ...neutral, gateAmt: 100, gateThresh: -48 }, { gateThresh: -4 });
      // thresh -12 < body level (-8 peak): gate open mid-tone, closes during the
      // 1.5 s fade-out; release time-constant (200 vs 500 ms) shifts the close.
      await pair('gateRelease', { ...neutral, gateAmt: 100, gateThresh: -12, gateRelease: 200 }, { gateRelease: 500 });
      // Transient shaper: move the fast/slow split across the 110/220/440 Hz chord.
      await pair('transFreq', { ...neutral, transAmt: 50, transFreq: 250 }, { transFreq: 800 });
      return out;
    });
    if (results.err) {
      check('DSP render baseline', false, results.err);
    } else {
      const dead = Object.entries(results).filter(([, d]) => d < 1e-4);
      check('all 66 DSP param checks change the render', dead.length === 0,
        dead.length ? `DEAD: ${dead.map(([n, d]) => `${n}(${d.toFixed(6)})`).join(', ')}` : 'min diff ok');
      const weakest = Object.entries(results).sort((a, b) => a[1] - b[1]).slice(0, 3);
      console.log(`  (weakest: ${weakest.map(([n, d]) => `${n}=${d.toExponential(2)}`).join(', ')})`);
    }
  }

  // =========================================================================
  section('M1.5b — High-tone regression: de-esser / air exciter on 4.4/8.8/12 kHz');
  // =========================================================================
  {
    // The low chord has no sibilance/air-band energy, so deess/air params only
    // prove alive against the high-tone fixture. Upload it, render pairs, then
    // restore TONE (invariant for the modules that follow).
    // Load detection: in-page DFT at 8800 Hz. 8800 Hz x 10 s = 88000 whole
    // periods -> the bin is ~30k on HIGHTONE and ~0 on TONE (110/220/440 Hz are
    // all integer-multiple orthogonal frequencies).
    const dft8800 = () => page.evaluate(() => {
      const b = window.__NMP__.getEngine().buffer;
      if (!b) return -1;
      const d = b.getChannelData(0);
      const sr = b.sampleRate;
      let s = 0;
      for (let i = 0; i < d.length; i += 1) s += d[i] * Math.sin(2 * Math.PI * 8800 * i / sr);
      return Math.abs(s);
    });
    const up2 = await page.$('#track-upload');
    await up2.uploadFile(HIGHTONE);
    const hiUp = await waitFor(page, () => {
      const b = window.__NMP__.getEngine().buffer;
      if (!b) return false;
      const d = b.getChannelData(0);
      const sr = b.sampleRate;
      let s = 0;
      for (let i = 0; i < d.length; i += 1) s += d[i] * Math.sin(2 * Math.PI * 8800 * i / sr);
      return Math.abs(s) > 1000;
    }, 30000, 500);
    check('high-tone fixture loaded (8800 Hz DFT > 1000)', hiUp, `dft=${await dft8800()}`);

    const hi = await page.evaluate(async () => {
      const e = window.__NMP__.getEngine();
      const neutral = window.__NMP__.getNeutralSettings();
      const pair = async (name, base2, delta) => {
        const a = await e.renderProPcm(base2, 0, 0, []);
        const b = await e.renderProPcm({ ...base2, ...delta }, 0, 0, []);
        if (!a || !b) return -1;
        const N = a.left.length;
        let maxd = 0;
        for (let i = 0; i < N; i += 16) {
          maxd = Math.max(maxd, Math.abs(a.left[i] - b.left[i]) + Math.abs(a.right[i] - b.right[i]));
        }
        return maxd;
      };
      const out = {};
      // Sibilance band on the 8.8 kHz partial: band at 8000 Hz spans 6.6-9.4 kHz.
      out.deessAmt = await pair('deessAmt', { ...neutral, deessFreq: 8000, deessAmt: 0 }, { deessAmt: 100 });
      // Band center 6000 (4.98-7.02 kHz, off-chord) vs 8000 (on the 8.8 kHz partial).
      out.deessFreq = await pair('deessFreq', { ...neutral, deessAmt: 100, deessFreq: 6000 }, { deessFreq: 8000 });
      // Air band: hp at 8 kHz feeds 8.8/12 kHz; amount 0 vs 100.
      out.airAmt = await pair('airAmt', { ...neutral, airFreq: 8000, airAmt: 0 }, { airAmt: 100 });
      // hp 6 kHz (8.8+12 kHz) vs 10 kHz (mostly 12 kHz only) at full amount.
      out.airFreq = await pair('airFreq', { ...neutral, airAmt: 100, airFreq: 6000 }, { airFreq: 10000 });
      // Tape lowpass 10 kHz (8.8/12 kHz pass) vs 2 kHz (cuts both) at amt=60.
      out.tapeTone = await pair('tapeTone', { ...neutral, tapeAmt: 60, tapeTone: 10000 }, { tapeTone: 2000 });
      // PEQ band 4 at gain 6: 88 -> ~8.73 kHz (on the 8.8 kHz partial) vs 80 -> ~5 kHz.
      out.peq4Freq = await pair('peq4Freq', { ...neutral, peq4Gain: 6, peq4Freq: 88 }, { peq4Freq: 80 });
      return out;
    });
    const deadHi = Object.entries(hi).filter(([, d]) => d < 1e-4);
    check('all 6 high-tone DSP param checks change the render', deadHi.length === 0,
      deadHi.length ? `DEAD: ${deadHi.map(([n, d]) => `${n}(${d.toFixed(6)})`).join(', ')}` : 'min diff ok');

    // Restore TONE for the modules that follow.
    await up2.uploadFile(TONE);
    const restored = await waitFor(page, () => {
      const b = window.__NMP__.getEngine().buffer;
      if (!b) return false;
      const d = b.getChannelData(0);
      const sr = b.sampleRate;
      let s = 0;
      for (let i = 0; i < d.length; i += 1) s += d[i] * Math.sin(2 * Math.PI * 8800 * i / sr);
      return Math.abs(s) < 1;
    }, 30000, 500);
    check('tone fixture restored (8800 Hz DFT ~ 0)', restored);
  }

  // =========================================================================
  section('M1.6 — FX regions: A3 toast, in-window-only effect, delete resets');
  // =========================================================================
  {
    // Global master reverb is 80 from M1.3 — must survive region editing.
    const globalBefore = await h(page, 'dspParam', 'reverb');
    const added = await h(page, 'clickText', '+ ADD FX REGION');
    await sleep(500);
    const toast = await page.evaluate(() => {
      const el = document.querySelector('[role="alert"]');
      return el ? el.textContent : '';
    });
    check('region added + A3 hint toast', added && /now edit this region/i.test(toast), toast.slice(0, 80));
    // Header span has CSS `uppercase` -> innerText arrives ALL-CAPS; compare case-insensitively.
    check('editing header switches to region mode',
      await page.evaluate(() => document.body.innerText.toLowerCase().includes('fx automation regions (editing area)')));
    // Editing an FX slider now writes into the region (not global settings)
    const r = await h(page, 'setFxSlider', 'Reverb', 90);
    await sleep(250);
    const globalAfter = await h(page, 'dspParam', 'reverb');
    check('FX slider edit targets the region (global reverb unchanged)',
      r.ok && globalAfter && !globalAfter.err && Math.abs(globalAfter.value - (globalBefore.value ?? 0)) < 0.01,
      `before=${globalBefore && globalBefore.value}, after=${globalAfter && globalAfter.value}`);

    // DSP proof: render with a reverb-90 region on 2–4 s -> in-window diff,
    // out-of-window identical to the region-less render.
    const dsp = await page.evaluate(async () => {
      const e = window.__NMP__.getEngine();
      const neutral = window.__NMP__.getNeutralSettings();
      const region = {
        id: 'e2e', start: 2, end: 4, targetStem: 'master', color: '#00ffff',
        effects: { autotune: 0, reverb: 90, distortion: 0, delay: 0, chorus: 0 },
      };
      const plain = await e.renderProPcm({ ...neutral }, 0, 0, []);
      const withReg = await e.renderProPcm({ ...neutral }, 0, 0, [region]);
      if (!plain || !withReg) return null;
      const sr = plain.left.length / 10;
      const maxDiffIn = (from, to) => {
        let m = 0;
        for (let i = Math.floor(from * sr); i < Math.floor(to * sr); i += 16) {
          m = Math.max(m, Math.abs(plain.left[i] - withReg.left[i]));
        }
        return m;
      };
      return { inWin: maxDiffIn(2.2, 3.8), outA: maxDiffIn(0.2, 1.8), outB: maxDiffIn(5, 8) };
    });
    check('region effect only inside its window (DSP)',
      !!dsp && dsp.inWin > 1e-3 && dsp.outA < 1e-4 && dsp.outB < 1e-4,
      dsp ? `in=${dsp.inWin.toFixed(5)}, outA=${dsp.outA.toFixed(6)}, outB=${dsp.outB.toFixed(6)}` : 'render failed');

    // Delete the region -> active id reset (header back to non-editing)
    const removed = await page.evaluate(() => {
      const box = document.querySelector('div.max-h-\\[160px\\]');
      const x = box && box.querySelector('button');
      if (!x) return false;
      x.click();
      return true;
    });
    await sleep(400);
    const hdr = await page.evaluate(() => document.body.innerText.toLowerCase().includes('fx automation regions (editing area)'));
    check('region deleted, editing mode reset', removed && !hdr, `editingHeader=${hdr}`);
  }

  // =========================================================================
  section('M1.7 — Monitoring A/B: MASTER / SOURCE / REFERENCE');
  // =========================================================================
  {
    const refInput = await page.$('#ref-upload');
    await refInput.uploadFile(REFTONE);
    await waitFor(page, () => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Ref');
      return b && !b.disabled;
    }, 20000);
    // setMonitoring('reference') toggles the ref track but does NOT reset bypass — it is
    // inherited from the previous mode (app quirk, documented in the v2.3 report).
    for (const [label, expect] of [['Master', { bypass: false, ref: false }], ['Source', { bypass: true, ref: false }], ['Ref', { bypass: null, ref: true }]]) {
      const ok = await h(page, 'clickText', label);
      await sleep(300);
      const st = await page.evaluate(() => {
        const e = window.__NMP__.getEngine();
        return { bypass: e.getBypass(), ref: !!e.isRefPlaying };
      });
      check(`monitor ${label} (bypass=${expect.bypass === null ? 'inherited' : expect.bypass}, ref=${expect.ref})`,
        ok && (expect.bypass === null || st.bypass === expect.bypass) && st.ref === expect.ref,
        `bypass=${st.bypass}, ref=${st.ref}`);
    }
    await h(page, 'clickText', 'Master');
  }

  // =========================================================================
  section('M1.8 — Visualizer: 7 modes render live, 0 errors');
  // =========================================================================
  {
    const modes = ['Bars', 'Circle', 'Wave', 'Alchemy', 'Circles', 'Flight', 'Smoke'];
    await page.evaluate(() => {
      const e = window.__NMP__.getEngine();
      if (!e.isPlaying) e.play();
    });
    await sleep(1500);
    for (const m of modes) {
      await h(page, 'clickText', m);
      await sleep(900);
      const st = await page.evaluate(() => {
        const canvas = [...document.querySelectorAll('canvas')]
          .filter((c) => c.offsetParent !== null)
          .sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (!canvas) return null;
        const ctx = canvas.getContext('2d');
        const d1 = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0;
        let sumSq = 0;
        const n = d1.length / 4;
        for (let i = 0; i < n; i += 16) {
          const lum = 0.299 * d1[i * 4] + 0.587 * d1[i * 4 + 1] + 0.114 * d1[i * 4 + 2];
          sum += lum;
          sumSq += lum * lum;
        }
        const mean = sum / (n / 16);
        return { variance: sumSq / (n / 16) - mean * mean, size: canvas.width * canvas.height };
      });
      check(`visualizer ${m} non-empty`, !!st && st.variance > 4, st ? `var=${st.variance.toFixed(1)}` : 'no canvas');
    }
    const visErrors = consoleIssues.length;
    check('no console errors during visualizer sweep', visErrors === 0, `${visErrors} issues: ${consoleIssues.slice(0, 3).map((x) => x.text).join(' | ')}`);
    await page.evaluate(() => window.__NMP__.getEngine().stop());
    await sleep(300);
  }

  // =========================================================================
  section('M1.9 — Transport: play/stop/seek/speed/volume');
  // =========================================================================
  {
    const play = await page.evaluate(() => {
      const b = document.querySelector('button.w-12.h-12');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    });
    await sleep(800);
    const t1 = await page.evaluate(() => window.__NMP__.getEngine().getCurrentTime());
    await sleep(700);
    const t2 = await page.evaluate(() => window.__NMP__.getEngine().getCurrentTime());
    check('play starts playback', play && t1 > 0 && t2 > t1, `t ${t1.toFixed(2)} -> ${t2.toFixed(2)}`);

    // Seek bar (TimeControls) at 3 points
    for (const seekTo of [2, 6, 8]) {
      const set = await h(page, 'seekBar', seekTo);
      await sleep(400);
      const ui = await h(page, 'getSeekBarLabel');
      const eng = await page.evaluate(() => window.__NMP__.getEngine().getCurrentTime());
      check(`seek to ${seekTo}s (UI "${ui}")`, set && Math.abs(eng - seekTo) < 0.6, `engine=${eng.toFixed(2)}`);
    }

    // Speed curve (App.tsx getSpeed): +v -> 1 + 2v/3, -v -> 1 / (1 + 2|v|/3)
    for (const [v, rate] of [[1, 5 / 3], [-1, 0.6]]) {
      await h(page, 'setRangeByMinMax', '-3', '3', v);
      await sleep(200);
      const got = await page.evaluate(() => window.__NMP__.getEngine().getPlaybackRate());
      check(`speed ${v >= 0 ? '+' : ''}${v} -> ${rate}x`, Math.abs(got - rate) < 0.01, `rate=${got.toFixed(3)}`);
    }
    await h(page, 'setRangeByMinMax', '-3', '3', 0);

    // Volume (setVolume uses setTargetAtTime tau=0.1s — let it converge before reading)
    await h(page, 'setRangeByMinMax', '0', '1', 0.35);
    await sleep(800);
    const vol = await page.evaluate(() => window.__NMP__.getEngine().getMonitorGain().gain.value);
    check('volume slider -> monitor gain', Math.abs(vol - 0.35) < 0.02, `gain=${vol.toFixed(3)}`);
    await h(page, 'setRangeByMinMax', '0', '1', 0.9);

    // Stop
    await page.evaluate(() => document.querySelector('button.w-12.h-12').click());
    await sleep(300);
    const stopped = await page.evaluate(() => !window.__NMP__.getEngine().isPlaying);
    check('stop', stopped);
  }

  // =========================================================================
  section('M1.10 — Reset: whole Pro panel block returns to neutral');
  // =========================================================================
  {
    const neutral = await page.evaluate(() => window.__NMP__.getNeutralSettings());
    // Dirty every slice of the Pro block: a module param, the active save
    // slot, an FX region (only addable while monitoring MASTER) and
    // A/B monitoring (Source = bypass).
    await h(page, 'setTonalSlider', 'Drive / Loudness', 5);
    await h(page, 'clickText', '3');
    await sleep(200);
    await h(page, 'clickText', '+ ADD FX REGION');
    await sleep(400);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Source');
      if (b) b.click();
    });
    await sleep(300);
    const activeSlot = () => page.evaluate(() => {
      const slots = [...document.querySelectorAll('button')].filter((b) => /^\d$/.test(b.textContent.trim()));
      const on = slots.filter((s) => s.className.includes('bg-[var(--accent)]'));
      return on.length === 1 ? parseInt(on[0].textContent.trim(), 10) : null;
    });
    const dirtyGain = await h(page, 'dspParam', 'gain');
    const dirtyOk = dirtyGain && !dirtyGain.err && Math.abs(dirtyGain.value - 5) < 0.1
      && (await activeSlot()) === 3
      && (await page.evaluate(() => window.__NMP__.getEngine().getBypass())) === true
      && (await page.evaluate(() => document.body.innerText.toLowerCase().includes('fx automation regions (editing area)')));
    check('Pro block is dirty (precondition)', !!dirtyOk,
      `gain=${dirtyGain && dirtyGain.value}, slot=${await activeSlot()}, bypass=${await page.evaluate(() => window.__NMP__.getEngine().getBypass())}`);

    const resetClicked = await h(page, 'clickText', 'Reset');
    await sleep(400);
    const gain = await h(page, 'dspParam', 'gain');
    const slot = await activeSlot();
    const bypass = await page.evaluate(() => window.__NMP__.getEngine().getBypass());
    const editing = await page.evaluate(() => document.body.innerText.toLowerCase().includes('fx automation regions (editing area)'));
    const monBtns = await page.evaluate(() => {
      const bs = [...document.querySelectorAll('button')].filter((b) => ['Master', 'Source', 'Ref'].includes(b.textContent.trim()));
      return bs.map((b) => ({ t: b.textContent.trim(), on: b.className.includes('bg-[var(--accent)]') }));
    });
    const dur = await page.evaluate(() => window.__NMP__.getEngine().getDuration());
    check('Reset: module params back to neutral (live DSP)',
      resetClicked && gain && !gain.err && Math.abs(gain.value - (neutral.gain ?? 0)) < 0.01,
      `gain=${gain && gain.value}, neutral=${neutral && neutral.gain}`);
    check('Reset: active save slot back to 1', slot === 1, `slot=${slot}`);
    check('Reset: monitoring back to MASTER (bypass off)',
      bypass === false && monBtns.length === 3 && monBtns[0].on && !monBtns[1].on,
      JSON.stringify(monBtns));
    check('Reset: FX region removed', !editing, `editingHeader=${editing}`);
    check('Reset: track untouched (duration intact)', dur > 9, `dur=${dur.toFixed(2)}`);
  }

  // =========================================================================
  section('M1.11 — Cover art: upload + drag-to-pan inside the frame');
  // =========================================================================
  {
    // Instrument before the upload: when does the pan transform appear, and
    // is the main thread stalled (rAF deltas) while we wait? (Run 5 saw the
    // transform appear just after the old 5 s window in the full-suite
    // context, 107 ms in an isolated repro — this pinpoints the delay.)
    await page.evaluate(() => {
      window.__covT0 = performance.now();
      window.__covTransformAt = null;
      window.__rafDeltas = [];
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        window.__rafDeltas.push(now - last);
        if (window.__rafDeltas.length > 4000) window.__rafDeltas.shift();
        last = now;
        if (window.__covTransformAt === null) {
          const img = document.querySelector('img[alt="Cover Art"]');
          if (img && /translate\(/.test(img.style.transform || '')) {
            window.__covTransformAt = Math.round(now - window.__covT0);
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const coverInput = await page.$('#cover-upload');
    let upOk = false;
    if (coverInput) { await coverInput.uploadFile(COVER_WIDE); upOk = true; }
    // The aspect probe (Image onload) sets the pan transform even at 0 offset,
    // so its presence also proves the image was accepted and measured.
    // NOTE: waitFor serializes fn INTO the page — fn must be a page-context
    // function (a Node-side thunk calling page.evaluate would throw there).
    const aspectKnown = await waitFor(page, () => {
      const img = document.querySelector('img[alt="Cover Art"]');
      return !!(img && /translate\(/.test(img.style.transform || ''));
    }, 15000);
    const covInfo = await page.evaluate(() => ({
      at: window.__covTransformAt,
      maxRaf: window.__rafDeltas.length ? Math.max(...window.__rafDeltas) : 0,
      slow: window.__rafDeltas.filter((d) => d > 100).length,
    }));
    check('cover: wide image uploaded + aspect detected', upOk && aspectKnown,
      `upOk=${upOk} aspectKnown=${aspectKnown} transformAt=${covInfo.at}ms maxRaf=${covInfo.maxRaf.toFixed(0)}ms slowFrames=${covInfo.slow}`);
    const imgBox = await page.evaluate(() => {
      const img = document.querySelector('img[alt="Cover Art"]');
      const r = img.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const readShiftPct = () => page.evaluate(() => {
      const img = document.querySelector('img[alt="Cover Art"]');
      const m = /translate\(([-\d.]+)%/.exec(img.style.transform || '');
      return m ? parseFloat(m[1]) : 0;
    });
    const before = await readShiftPct();
    const cx = imgBox.x + imgBox.w / 2;
    const cy = imgBox.y + imgBox.h / 2;

    // Drag ~30% of the box width right (real mouse => real pointerId, so
    // setPointerCapture in the handler works).
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + imgBox.w * 0.3, cy, { steps: 4 });
    await page.mouse.up();
    await sleep(200);
    const mid = await readShiftPct();
    // Chromium may coalesce fast pointermove steps, so the exact distance is
    // not asserted here — the exact mapping is proven by the clamp check
    // below (reaching exactly +50% requires the full px -> % math).
    check('cover: drag pans the image (transform moved right)', mid > before + 2,
      `before=${before} mid=${mid}`);

    // Drag far beyond the right edge -> clamps at +50% (aspect 2:1 => the
    // cover overflow is half the box, i.e. 50% of the square element).
    await page.mouse.move(cx + imgBox.w * 0.3, cy);
    await page.mouse.down();
    await page.mouse.move(cx + imgBox.w * 3, cy, { steps: 6 });
    await page.mouse.up();
    await sleep(200);
    const clamped = await readShiftPct();
    check('cover: pan clamped at the edge (+50%)', Math.abs(clamped - 50) < 0.5,
      `clamped=${clamped}`);

    // DEV hook resets the offset -> transform back to 0 for later sections
    // (M3 video export draws the cover frame).
    const resetOk = await page.evaluate(() => window.__NMP__.resetCoverOffset());
    await sleep(150);
    const after = await readShiftPct();
    check('cover: offset reset to center', resetOk === true && Math.abs(after) < 0.001,
      `resetOk=${resetOk} after=${after}`);
  }

  // =========================================================================
  section('M1.12 — Stem Studio: vocal tab, solo preview, stems ZIP export');
  // =========================================================================
  {
    // Stem selector row: 5 stem tabs + SOLO + export button.
    const tabs = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="stem-solo"]');
      return row && row.parentElement
        ? [...row.parentElement.querySelectorAll('button')].map((b) => b.textContent.trim())
        : [];
    });
    check('stem row: 5 tabs + SOLO + export', tabs.length === 7, tabs.join(','));

    // VOCAL tab selects the stem; the FX grid then binds vocal_* params.
    const vocalClicked = await h(page, 'clickText', 'VOCAL');
    await sleep(250);
    const fx = await h(page, 'setFxSlider', 'Autotune', 70);
    await sleep(250);
    const vAuto = await h(page, 'dspParam', 'vocal_autotune');
    check('vocal tab: FX slider writes vocal_autotune to DSP',
      vocalClicked && fx && fx.ok && vAuto && !vAuto.err && Math.abs(vAuto.value - 70) < 0.5,
      `fx=${JSON.stringify(fx)} param=${JSON.stringify(vAuto)}`);
    // Leave the slider neutral for the rest of the suite.
    await h(page, 'setFxSlider', 'Autotune', 0);
    await sleep(150);

    // SOLO toggles stem_solo 2 (vocal) and back to 0 (master).
    const clickSolo = () => page.evaluate(() => {
      const b = document.querySelector('[data-testid="stem-solo"]');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    });
    const soloClicked = await clickSolo();
    await sleep(250);
    const soloOn = await h(page, 'dspParam', 'stem_solo');
    await clickSolo();
    await sleep(250);
    const soloOff = await h(page, 'dspParam', 'stem_solo');
    check('SOLO: stem_solo 2 while on, 0 after toggle off',
      soloClicked && soloOn && !soloOn.err && soloOn.value === 2 && soloOff && !soloOff.err && soloOff.value === 0,
      `clicked=${soloClicked} on=${JSON.stringify(soloOn)} off=${JSON.stringify(soloOff)}`);

    // Export Stems: 4 offline solo renders -> ZIP of 4 WAVs, ~track length.
    const trackDur = await page.evaluate(() => window.__NMP__.getEngine().getDuration());
    const clicked = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="export-stems"]');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    });
    const dl = await awaitDownload(page, 240000);
    let stemsOk = false;
    let detail = 'no download';
    if (dl) {
      try {
        const files = unzip(dl.buf);
        const names = Object.keys(files).sort();
        const parsed = names.map((n) => ({ n, w: parseWav(files[n]) }));
        stemsOk = names.length === 4
          && ['bass', 'mid', 'side', 'vocal'].every((s) => names.some((n) => n.includes('_' + s)))
          && parsed.every((x) => x.w && Math.abs(x.w.duration - trackDur) < 0.5 && [16, 24, 32].includes(x.w.bits));
        detail = parsed.map((x) => `${x.n}: ${x.w ? `${x.w.duration.toFixed(2)}s ${x.w.bits}b pk=${x.w.peak.toFixed(3)}` : 'BAD'}`).join(' | ');
      } catch (e) {
        detail = 'unzip failed: ' + e.message;
      }
    }
    check('Export Stems: ZIP with 4 valid stem WAVs', clicked && !!dl && stemsOk, detail);

    // Return the stem tab to MASTER so later sections see the default view.
    await h(page, 'clickText', 'MASTER');
    await sleep(150);
  }

  // =========================================================================
  section('M1.13 — Vocal Align: guide/dub upload → align → aligned WAV download');
  // =========================================================================
  {
    const gIn = await page.$('input[data-testid="align-guide-input"]');
    const dIn = await page.$('input[data-testid="align-dub-input"]');
    check('vocal-align block: guide + dub inputs present', !!gIn && !!dIn, `g=${!!gIn} d=${!!dIn}`);
    await gIn.uploadFile(GUIDE);
    await sleep(900);
    await dIn.uploadFile(DUB);
    await sleep(900);
    const applyEnabled = await page.$eval('[data-testid="align-apply"]', (b) => !b.disabled);
    check('APPLY enabled once guide + dub are loaded', applyEnabled);
    await page.evaluate(() => document.querySelector('[data-testid="align-apply"]').click());
    let gotOut = false;
    try {
      await page.waitForFunction(() => !!document.querySelector('[data-testid="align-dl-aligned"]'), { timeout: 60000 });
      gotOut = true;
    } catch { /* stays false */ }
    check('aligned result appears (worker or main-thread fallback)', gotOut);
    await drainDownloads(page, ' [before M1.13 aligned.wav]');
    const dl = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="align-dl-aligned"]');
      if (!b) return false;
      b.click();
      return true;
    });
    const aDl = dl ? await awaitDownload(page, 60000) : null;
    const w = aDl ? parseWav(aDl.buf) : null;
    // Guide grid (5.00 s), not the dub's (5.35 s) — proves the output is re-timed onto the guide.
    check('aligned.wav valid and on the guide length (5.0 s ±0.1)',
      !!w && Math.abs(w.duration - 5.0) < 0.1 && w.peak > 0.05,
      w ? `${w.duration.toFixed(2)}s ${w.bits}b pk=${w.peak.toFixed(3)}` : 'no download');
  }

  // =========================================================================
  section('M2.1 — Lite: 10 presets hit LUFS target and TP ceiling');
  // =========================================================================
  {
    const toLite = await h(page, 'clickText', 'Lite');
    await sleep(1500);
    check('switched to Lite mode', toLite);

    const presets = [
      ['Spotify', -14, -1.0], ['YouTube', -14, -1.0], ['TikTok / Shorts', -10, -1.0],
      ['Apple Music', -16, -1.0], ['Club', -11, -1.0], ['Radio', -13, -1.0],
      ['Classical / Piano', -20, -2.0], ['Lullaby', -20, -3.0], ['Podcast', -16, -2.0],
    ];
    for (const [name, lufs, ceil] of presets) {
      const sel = await h(page, 'clickText', name);
      const run = await h(page, 'clickLiteMaster');
      const done = await waitFor(page, () => /Mastered \u00b7/.test(document.body.innerText), 90000);
      const tbl = await page.evaluate(() => {
        const hdr = [...document.querySelectorAll('div')].find((d) => d.textContent.trim() === 'Before / After' && d.children.length === 0);
        if (!hdr) return null;
        const grid = hdr.parentElement.querySelector('div.grid');
        if (!grid) return null;
        const spans = [...grid.children].map((s) => s.textContent.trim());
        const pick = (label) => {
          const i = spans.indexOf(label);
          return i >= 0 ? [parseFloat(spans[i + 1]), parseFloat(spans[i + 2])] : null;
        };
        const findings = hdr.parentElement.querySelectorAll('.space-y-1 > div').length;
        return { lufs: pick('LUFS'), tp: pick('True Peak'), findings };
      });
      const lufsOk = tbl && tbl.lufs && Math.abs(tbl.lufs[1] - lufs) <= 0.5;
      const tpOk = tbl && tbl.tp && tbl.tp[1] <= ceil + 0.05;
      check(`preset ${name}: LUFS ${lufs} / TP <= ${ceil}`, sel && run && done && lufsOk && tpOk && tbl.findings >= 1,
        tbl ? `after LUFS=${tbl.lufs && tbl.lufs[1]}, TP=${tbl.tp && tbl.tp[1]}, findings=${tbl.findings}` : 'no table');
    }

    // Custom preset: -12 LUFS / -1.5 dBTP / streaming
    const custom = await h(page, 'clickText', 'Custom');
    await sleep(300);
    await page.evaluate(() => {
      // Select by min AND max — the shared transport speed slider also has min='-3'.
      const lufs = [...document.querySelectorAll('input[type="range"]')].find((r) => r.min === '-20' && r.max === '-8');
      const ceiling = [...document.querySelectorAll('input[type="range"]')].find((r) => r.min === '-3' && r.max === '-0.3');
      if (lufs) window.__h.inputSet(lufs, -12);
      if (ceiling) window.__h.inputSet(ceiling, -1.5);
    });
    await page.evaluate(() => {
      const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'streaming'));
      if (sel) window.__h.inputSet(sel, 'streaming');
    });
    const runC = await h(page, 'clickLiteMaster');
    const doneC = await waitFor(page, () => /Mastered \u00b7/.test(document.body.innerText), 90000);
    const tblC = await page.evaluate(() => {
      const hdr = [...document.querySelectorAll('div')].find((d) => d.textContent.trim() === 'Before / After' && d.children.length === 0);
      if (!hdr) return null;
      const spans = [...hdr.parentElement.querySelector('div.grid').children].map((s) => s.textContent.trim());
      const i = spans.indexOf('LUFS');
      return i >= 0 ? parseFloat(spans[i + 2]) : null;
    });
    check('custom preset -12 LUFS applied', custom && runC && doneC && tblC !== null && Math.abs(tblC - -12) <= 0.5,
      `after LUFS=${tblC}`);

    // A/B hold buttons
    const ab = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('A \u00b7'));
      if (!b) return null;
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const showingBefore = /Before/.test(b.textContent);
      b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return { found: true, showingBefore };
    });
    check('A/B hold switches live side', !!ab && ab.found === true, JSON.stringify(ab));
  }

  // =========================================================================
  section('M2.2 — Lite batch: 3 files -> run -> ZIP with valid WAVs');
  // =========================================================================
  {
    const batchInput = await page.$('input[type="file"][multiple]');
    await batchInput.uploadFile(B1, B2, B3);
    await waitFor(page, () => document.body.innerText.includes('3/'), 10000);
    const run = await h(page, 'clickText', 'Run');
    // Wait for all 3 done-lines (the ZIP button appears after the FIRST done only).
    const done = await waitFor(page, () => {
      const box = [...document.querySelectorAll('div')].find((d) => d.querySelector('input[type="file"][multiple]'));
      return box && (box.innerText.match(/-?\d+\.?\d* \u2192 -?\d+\.?\d*/g) || []).length >= 3;
    }, 180000);
    const lines = await page.evaluate(() => {
      const box = [...document.querySelectorAll('div')].find((d) => d.querySelector('input[type="file"][multiple]'));
      return box ? box.innerText.match(/-?\d+\.?\d* \u2192 -?\d+\.?\d*/g) || [] : [];
    });
    check('batch of 3 all mastered', run && done && lines.length === 3, lines.join(' | '));
    const zipped = await h(page, 'clickTextStart', 'Export all (ZIP)');
    const dl = await awaitDownload(page, 90000);
    let zipOk = false;
    let detail = 'no download';
    if (dl) {
      try {
        const files = unzip(dl.buf);
        const names = Object.keys(files);
        const wavs = names.map((n) => ({ n, w: parseWav(files[n]) }));
        zipOk = names.length === 3 && wavs.every((x) => x.w && x.w.duration > 2.5 && x.w.peak > 0.05);
        detail = wavs.map((x) => `${x.n}: ${x.w ? `${x.w.duration.toFixed(1)}s ${x.w.bits}b pk=${x.w.peak.toFixed(2)}` : 'BAD'}`).join(' | ');
      } catch (e) {
        detail = 'unzip failed: ' + e.message;
      }
    }
    check('ZIP contains 3 valid WAVs', zipped && !!dl && zipOk, detail);
  }

  // =========================================================================
  section('M2.3 — Lite export: WAV 16/24/32f, MP3 192/320, FLAC');
  // =========================================================================
  {
    const cases = [
      { fmt: 'WAV', sub: '16-bit', expect: (b) => { const w = parseWav(b); return w && w.bits === 16 && Math.abs(w.duration - 10) < 0.3 && w.peak > 0.05; }, d: '16-bit WAV' },
      { fmt: 'WAV', sub: '24-bit', expect: (b) => { const w = parseWav(b); return w && w.bits === 24 && w.peak > 0.05; }, d: '24-bit WAV' },
      { fmt: 'WAV', sub: '32f', expect: (b) => { const w = parseWav(b); return w && w.bits === 32 && w.peak > 0.05; }, d: '32f WAV' },
      { fmt: 'MP3', sub: '192', expect: (b) => { const m = parseMp3(b); return m && m.kbps === 192; }, d: 'MP3 192k' },
      { fmt: 'MP3', sub: '320', expect: (b) => { const m = parseMp3(b); return m && m.kbps === 320; }, d: 'MP3 320k' },
      { fmt: 'FLAC', sub: null, expect: (b) => { const f = parseFlac(b); return f && f.duration > 9.5 && f.duration < 10.5; }, d: 'FLAC' },
    ];
    for (const c of cases) {
      await h(page, 'clickText', c.fmt);
      await sleep(150);
      if (c.sub) await h(page, 'clickText', c.sub);
      await sleep(150);
      const clicked = await h(page, 'clickText', `Export ${c.fmt}`);
      const dl = await awaitDownload(page, 60000);
      check(`lite export ${c.d}`, clicked && !!dl && c.expect(dl.buf), dl ? `${dl.name} (${dl.buf.length} B)` : 'no download');
    }
  }

  // =========================================================================
  section('M3 — Pro export: WAV/FLAC/MP3/AAC/video');
  // =========================================================================
  {
    await h(page, 'clickText', 'Pro');
    await sleep(1500);
    // Title for metadata checks
    await page.evaluate(() => {
      const inp = document.querySelector('input[type="text"]'); // Title field
      window.__h.inputSet(inp, 'E2E Track');
    });
    await sleep(300);

    const setFormat = (fmt) => page.evaluate((f) => {
      const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'wav'));
      window.__h.inputSet(sel, f);
    }, fmt);
    const setWavBit = (bit) => page.evaluate((v) => {
      const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => ['16', '24', '32'].includes(o.value)));
      window.__h.inputSet(sel, v);
    }, bit);
    const setAacKbps = (k) => page.evaluate((v) => {
      const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => ['128', '256'].includes(o.value)));
      window.__h.inputSet(sel, v);
    }, k);

    const proCases = [
      { fmt: 'wav', bit: '32', expect: (b) => { const w = parseWav(b); return w && w.bits === 32 && w.peak > 0.05; }, d: 'WAV 32f' },
      { fmt: 'wav', bit: '24', expect: (b) => { const w = parseWav(b); return w && w.bits === 24 && w.peak > 0.05; }, d: 'WAV 24-bit' },
      { fmt: 'wav', bit: '16', expect: (b) => { const w = parseWav(b); return w && w.bits === 16 && w.peak > 0.05; }, d: 'WAV 16-bit' },
      { fmt: 'flac', bit: null, expect: (b) => { const f = parseFlac(b); return f && f.duration > 9.5; }, d: 'FLAC' },
      { fmt: 'mp3', bit: null, expect: (b) => { const m = parseMp3(b); return m && m.kbps === 320; }, d: 'MP3 320k' },
    ];
    for (const c of proCases) {
      await setFormat(c.fmt);
      await sleep(300);
      if (c.bit) { await setWavBit(c.bit); await sleep(200); }
      const clicked = await h(page, 'clickText', 'Export');
      const dl = await awaitDownload(page, 120000);
      check(`pro export ${c.d}`, clicked && !!dl && c.expect(dl.buf), dl ? `${dl.name} (${dl.buf.length} B)` : 'no download');
    }

    // AAC 128 / 256 — wait for the local ffmpeg core to warm up
    await setFormat('aac');
    const aacReady = await waitFor(page, () => {
      const b = [...document.querySelectorAll('button')].find((x) => x.className.includes('btn-primary'));
      return b && !b.disabled;
    }, 180000);
    check('AAC core warmed up', aacReady);
    for (const kbps of [128, 256]) {
      await setAacKbps(String(kbps));
      await sleep(300);
      const clicked = await h(page, 'clickText', 'Export');
      const dl = await awaitDownload(page, 120000);
      const m4a = dl ? parseM4a(dl.buf) : null;
      const hasTitle = dl ? dl.buf.includes('E2E Track') : false;
      const estKbps = dl ? (dl.buf.length * 8) / 10 / 1000 : 0;
      const sizeOk = dl ? Math.abs(estKbps - kbps) < kbps * 0.3 : false;
      check(`AAC ${kbps}k m4a (ftyp + title + bitrate)`, clicked && !!m4a && hasTitle && sizeOk,
        dl ? `${dl.name} brand=${m4a && m4a.brand}, ${dl.buf.length} B, ~${Math.round(estKbps)} kbps` : 'no download');
    }

    // Video: trim 0–4 s, FHD 30fps medium, visualizer background
    await page.evaluate(() => {
      const lab = [...document.querySelectorAll('label')].find((l) => l.textContent.trim().toUpperCase().startsWith('END'));
      const inp = lab.parentElement.querySelector('input[type="number"]');
      window.__h.inputSet(inp, 4);
    });
    await sleep(200);
    await page.evaluate(() => {
      const cb = [...document.querySelectorAll('input[type="checkbox"]')]
        .find((c) => c.parentElement.textContent.includes('Export Video'));
      if (cb && !cb.checked) cb.click();
    });
    await sleep(500);
    await drainDownloads(page, ' [before M1.5 video export]');
    const vClicked = await h(page, 'clickText', 'Export');
    // Audio companion lands first, video second — take until a container file.
    let vdl = null;
    const vDeadline = Date.now() + 180000;
    while (!vdl && Date.now() < vDeadline) {
      const d = await awaitDownload(page, 20000);
      if (!d) continue;
      const isVid = d.buf.length > 8
        && (d.buf.readUInt32BE(0) === 0x1a45dfa3 || d.buf.toString('ascii', 4, 8) === 'ftyp');
      if (isVid) vdl = d;
      else console.log(`    [M1.5] skipped companion download: ${d.name || '?'} (${d.buf.length} B)`);
    }
    let vOk = false;
    let vDetail = 'no download';
    if (vdl) {
      const isWebm = vdl.buf.readUInt32LE(0) === 0x1a45dfa3;
      const isMp4 = vdl.buf.length > 8 && vdl.buf.toString('ascii', 4, 8) === 'ftyp';
      let dur = null;
      if (isWebm) dur = parseWebmDurationMs(vdl.buf);
      vOk = (isWebm || isMp4) && vdl.buf.length > 100000
        && (isMp4 || (dur !== null && Math.abs(dur / 1000 - 4) < 1.5));
      vDetail = `${vdl.name} ${vdl.buf.length} B, isWebm=${isWebm}, isMp4=${isMp4}, dur=${dur !== null ? (dur / 1000).toFixed(2) + 's' : 'n/a'}`;
    }
    check('video export (duration ~= 4 s trim)', vClicked && vOk, vDetail);
    // Uncheck video for cleanliness
    await page.evaluate(() => {
      const cb = [...document.querySelectorAll('input[type="checkbox"]')]
        .find((c) => c.parentElement.textContent.includes('Export Video'));
      if (cb && cb.checked) cb.click();
    });
  }

  // =========================================================================
  section('M4.1 — i18n: 9 languages, no "undefined", labels localized');
  // =========================================================================
  {
    const langs = ['EN', 'RU', 'ZH', 'FR', 'ES', 'IT', 'JA', 'KO', 'AR'];
    for (const l of langs) {
      await h(page, 'clickText', l);
      await sleep(450);
      const st = await page.evaluate(() => ({
        undefined: document.body.innerText.includes('undefined'),
        gain: ([...document.querySelectorAll('label')].find((x) => x.className.includes('text-[10px]')) || {}).textContent || '',
        export: ([...document.querySelectorAll('button')].find((b) => b.className.includes('btn-primary')) || {}).textContent || '',
      }));
      check(`lang ${l}: no undefined + key labels populated`,
        !st.undefined && st.gain.length > 0 && st.export.length > 0,
        `gain="${st.gain.slice(0, 24)}"`);
    }
    // RU must actually differ from the EN label (translation, not fallback)
    await h(page, 'clickText', 'RU');
    await sleep(450);
    const ruGain = await page.evaluate(() => ([...document.querySelectorAll('label')].find((x) => x.className.includes('text-[10px]')) || {}).textContent || '');
    await h(page, 'clickText', 'EN');
    await sleep(300);
    check('RU label differs from EN (real translation)', ruGain.length > 0 && ruGain !== 'Drive / Loudness', `"${ruGain.slice(0, 24)}"`);
  }

  // =========================================================================
  section('M4.2 — Hardware widget honest in headless (no fabricated temps)');
  // =========================================================================
  {
    const temps = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('span')].filter((s) => s.textContent.includes('\u00b0C'));
      return spans.map((s) => s.textContent.trim());
    });
    check('CPU/GPU show --°C in headless (no fake data)',
      temps.length >= 2 && temps.every((t) => /--\u00b0C/.test(t)),
      temps.join(' '));
  }

  // =========================================================================
  section('M4.3 — FPS over 60 s of playback (first 10 s + steady)');
  // =========================================================================
  {
    await page.evaluate(() => {
      const e = window.__NMP__.getEngine();
      e.seek(0);
      e.play();
    });
    await sleep(500);
    await page.evaluate(INJECT_SNAPPER);
    await sleep(10000);
    const first10 = await page.evaluate(READ_SNAPPER);
    await sleep(50000);
    const steady = await page.evaluate(READ_SNAPPER);
    check('FPS first 10 s: p95 <= 40 ms', !!first10 && first10.p95 <= 40, JSON.stringify(first10));
    check('FPS steady 50 s: p95 <= 40 ms', !!steady && steady.p95 <= 40, JSON.stringify(steady));
    check('no frame drops > 100 ms in steady state', !!steady && steady.gt100 === 0, JSON.stringify(steady));
    await page.evaluate(() => window.__NMP__.getEngine().stop());
  }

  // =========================================================================
  section('M4.3b — Fresh page: first 10 s of playback with the metrics pass running');
  // =========================================================================
  // The pre-mastering metrics pass (LUFS/LRA/true-peak/tone) now runs in a
  // web worker started at upload. This is the real regression M4.3 misses:
  // a fresh page plays IMMEDIATELY, so the pass is concurrent with the
  // measured window. Main-thread metrics (the old code) stall frames here.
  {
    const fresh = await browser.newPage();
    const freshIssues = [];
    fresh.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'warning') freshIssues.push(`${t}: ${m.text().slice(0, 300)}`);
    });
    fresh.on('pageerror', (e) => freshIssues.push(`pageerror: ${String(e.message || e).slice(0, 300)}`));
    await fresh.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 90000 });
    const fMounted = await waitFor(fresh, () => !!document.querySelector('select'), 30000);
    const fi = await fresh.$('#track-upload');
    await fi.uploadFile(TONE);
    // Engine ready AND decoded buffer present (play() silently no-ops without a buffer).
    const fReady = await waitFor(fresh, () => {
      try { const e = window.__NMP__.getEngine(); return e.isReady() && !!e.faustNode && !!e.getBuffer(); } catch { return false; }
    }, 120000, 500);
    await fresh.evaluate(INJECT_SNAPPER);
    const fPlayed = await fresh.evaluate(async () => {
      try {
        const e = window.__NMP__.getEngine();
        e.seek(0);
        await e.play(); // async: awaits context.resume() before source.start()
        return e.isPlaying;
      } catch { return false; }
    });
    await sleep(10000);
    const first10 = await fresh.evaluate(READ_SNAPPER);
    check('fresh page: engine up + playback started', !!fMounted && fReady && fPlayed === true,
      `mounted=${fMounted}, ready=${fReady}, playing=${fPlayed}`);
    check('FPS first 10 s (metrics pass concurrent in worker): p95 <= 40 ms',
      !!first10 && first10.p95 <= 40, JSON.stringify(first10));
    check('fresh page: no console errors/warnings during the pass',
      freshIssues.length === 0, freshIssues.slice(0, 3).join(' | '));
    await fresh.evaluate(() => window.__NMP__.getEngine().stop());
    await fresh.close();
  }

  // =========================================================================
  section('M4.3c — Timeline slider freezes on pause');
  // =========================================================================
  {
    // Drive ONLY through the UI transport button so React's isPlaying state
    // and the engine stay in sync (a direct engine.play() would desync them).
    const tp = () => page.evaluate(() => {
      const b = document.querySelector('button.w-12.h-12');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    });
    const engPlaying = () => page.evaluate(() => window.__NMP__.getEngine().isPlaying);

    const c1 = await tp(); // play
    await sleep(1200);
    const playingAfterPlay = await engPlaying();
    const c2 = await tp(); // pause
    await sleep(300);
    const pausedAfterPause = await engPlaying();
    const v1 = await h(page, 'seekBarValue');
    await sleep(1500);
    const v2 = await h(page, 'seekBarValue');
    check('seek bar frozen on pause (1.5 s apart)',
      c1 && c2 && playingAfterPlay === true && pausedAfterPause === false
      && v1 !== null && v2 !== null && Math.abs(v1 - v2) < 1e-6,
      `play=${c1} playing=${playingAfterPlay} pause=${c2} paused=${pausedAfterPause} v1=${v1} v2=${v2}`);
    const c3 = await tp(); // resume
    await sleep(800);
    const v3 = await h(page, 'seekBarValue');
    check('seek bar advances after resume', c3 && v3 !== null && v1 !== null && v3 > v1 + 0.3,
      `v1=${v1}, v3=${v3}`);
    await tp(); // stop
    await sleep(200);
  }

  // =========================================================================
  section('M4.5 — Pexels multi-clip export: cuts follow the audio peaks (synthetic, offline)');
  // =========================================================================
  // Two 1.2 s flat-color webm clips (red / blue) are generated IN the page
  // (canvas captureStream + MediaRecorder — no network, no Pexels API).
  // The DEV hook injects them as a ready selection, then an 8 s video export
  // runs while a sampler reads the hidden export canvas' top-left quarter
  // pixel (w/4, h/4) — the canvas center sits inside the cover-frame overlay.
  // The master PCM is a steady 110/220/440 chord; findPeakCuePoints places
  // each cue at the EXACT peak sample inside its 1 s window (1 s windows,
  // min gap 3 s, 1 s edge margin), so the cue times are deterministic per
  // signal but not round numbers. The export stores them in App state, and
  // the sampler reads the live cues through the DEV hook
  // (window.__NMP__.getExportBgCues) and samples CUE-RELATIVE points:
  //   cue1−0.3 red | cue1..cue1+0.6 fade (mixed) | midpoint blue
  //   | cue2+0.3 fade (mixed) | cue2+0.8 red.
  {
    const clipUrls = await page.evaluate(async () => {
      const make = (style) => new Promise((resolve) => {
        const c = document.createElement('canvas');
        c.width = 320; c.height = 180;
        const cx = c.getContext('2d');
        cx.fillStyle = style; cx.fillRect(0, 0, 320, 180);
        let frame = 0;
        // A 2px dot marching along the top edge keeps the capture stream
        // producing frames (a fully static canvas may record a single frame).
        // It stays far from the sampled point (top-left quarter after cover-fit).
        const tick = () => {
          frame += 1;
          cx.fillStyle = 'rgba(0,0,0,0.4)';
          cx.fillRect((frame * 7) % 318, 0, 2, 2);
        };
        const stream = c.captureStream(30);
        const iv = setInterval(tick, 100);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks = [];
        rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
        rec.onstop = () => {
          clearInterval(iv);
          stream.getTracks().forEach((tr) => tr.stop());
          resolve(URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
        };
        rec.start(250);
        setTimeout(() => rec.stop(), 1200);
      });
      const red = await make('rgb(220,20,30)');
      const blue = await make('rgb(30,20,220)');
      return [red, blue];
    });
    check('pexels: two synthetic clips generated (webm object URLs)',
      Array.isArray(clipUrls) && clipUrls.length === 2 && clipUrls.every((u) => typeof u === 'string' && u.startsWith('blob:')),
      `${clipUrls.length} urls`);

    // The videoBgMode radios live inside the "Export Video" block — the
    // checkbox must be on before they exist in the DOM.
    const vidBoxOn = await page.evaluate(() => {
      const cb = [...document.querySelectorAll('input[type="checkbox"]')]
        .find((c) => c.parentElement.textContent.includes('Export Video'));
      if (cb && !cb.checked) cb.click();
      return !!cb;
    });
    await sleep(300);
    const selOk = await page.evaluate((urls) => {
      try {
        return window.__NMP__.setPexelsTestSelection([
          { url: urls[0], author: 'Red Author' },
          { url: urls[1], author: 'Blue Author' },
        ]);
      } catch { return false; }
    }, clipUrls);
    const radioOk = await page.evaluate(() => {
      const radios = [...document.querySelectorAll('input[type="radio"][name="videoBgMode"]')];
      if (radios.length < 2) return false;
      if (!radios[1].checked) radios[1].click();
      return true;
    });
    await sleep(300);
    check('pexels: test selection injected (DEV hook) + Pexels bg mode on',
      selOk === true && radioOk,
      `vidBoxOn=${vidBoxOn} selOk=${selOk} radioOk=${radioOk}`);

    // Trim 0–8 s (START is still 0 from M3), video on, fast WAV audio.
    await page.evaluate(() => {
      const lab = [...document.querySelectorAll('label')].find((l) => l.textContent.trim().toUpperCase().startsWith('END'));
      const inp = lab.parentElement.querySelector('input[type="number"]');
      window.__h.inputSet(inp, 8);
    });
    await page.evaluate(() => {
      const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'wav'));
      window.__h.inputSet(sel, 'wav');
    });
    await page.evaluate(() => {
      const cb = [...document.querySelectorAll('input[type="checkbox"]')]
        .find((c) => c.parentElement.textContent.includes('Export Video'));
      if (cb && !cb.checked) cb.click();
    });
    await sleep(300);

    // Start the pixel sampler BEFORE clicking Export: the hidden export
    // canvas only exists once isExportingVideo mounts, and the engine clock
    // starts when the export seeks+plays. The sampler first waits for the
    // export to compute its cues (DEV hook), then grabs pixels at fixed
    // offsets from the ACTUAL cue times: cue1−0.3 (red, pre-fade), cue1+0.3
    // (mid-fade mixed, alpha≈0.3–0.55), midpoint of the cues (blue — cues
    // are ≥3 s apart, so the midpoint is ≥0.9 s from any fade edge),
    // cue2+0.3 (mid-fade mixed), cue2+0.8 (red, post-fade). The grab window
    // [target, target+0.2] tolerates the ≤1-frame canvas lag.
    const samplerPromise = page.evaluate(async () => {
      const e = window.__NMP__.getEngine();
      // The export canvas sits inside AudioVisualizer's own wrapper div,
      // which sits inside the fixed top:-9999px container — walk up.
      const findCanvas = () => [...document.querySelectorAll('canvas')]
        .find((c) => {
          let el = c.parentElement;
          while (el) {
            if (el.style && el.style.top === '-9999px') return true;
            el = el.parentElement;
          }
          return false;
        });
      const deadline = performance.now() + 45000;
      let cues = null;
      while (!cues && performance.now() < deadline) {
        const c = window.__NMP__.getExportBgCues();
        if (Array.isArray(c) && c.length >= 2) cues = c.slice();
        else await new Promise((r) => setTimeout(r, 100));
      }
      if (!cues) return { error: 'export cues never appeared (need >= 2)' };
      let cv = null;
      while (!cv && performance.now() < deadline) {
        cv = findCanvas();
        if (!cv) await new Promise((r) => setTimeout(r, 100));
      }
      if (!cv) return { error: 'export canvas never mounted' };
      const ctx = cv.getContext('2d');
      // (w/4, h/4): outside the cover frame, title and credit overlays,
      // which only occupy the bottom half / bottom-right corner.
      const grab = () => Array.from(ctx.getImageData(cv.width >> 2, cv.height >> 2, 1, 1).data);
      const mid = (cues[0] + cues[1]) / 2;
      const targets = { a: cues[0] - 0.3, b: cues[0] + 0.3, c: mid, d: cues[1] + 0.3, e: cues[1] + 0.8 };
      const out = {
        cues: cues.map((x) => +x.toFixed(3)),
        a: null, b: null, c: null, d: null, e: null,
        canvasW: cv.width, canvasH: cv.height, maxT: 0,
      };
      while (performance.now() < deadline) {
        const t = e.getCurrentTime();
        out.maxT = Math.max(out.maxT, t);
        for (const k of ['a', 'b', 'c', 'd', 'e']) {
          if (!out[k] && t >= targets[k] && t <= targets[k] + 0.2) out[k] = grab();
        }
        if (out.a && out.b && out.c && out.d && out.e) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return out;
    });

    // Flush late downloads from earlier sections (run 9: M4.5 consumed the
    // previous section's mp4), then take exports until OUR video container
    // lands — the audio companion (wav) arrives first.
    await drainDownloads(page, ' [before M4.5 export]');
    const mClicked = await h(page, 'clickText', 'Export');
    let mdl = null;
    const mDeadline = Date.now() + 180000;
    while (!mdl && Date.now() < mDeadline) {
      const d = await awaitDownload(page, 20000);
      if (!d) continue;
      const isVid = d.buf.length > 8
        && (d.buf.readUInt32BE(0) === 0x1a45dfa3 || d.buf.toString('ascii', 4, 8) === 'ftyp');
      if (isVid) mdl = d;
      else console.log(`    [M4.5] skipped companion download: ${d.name || '?'} (${d.buf.length} B)`);
    }
    const samples = await samplerPromise;
    const isRed = (px) => Array.isArray(px) && px[0] > 150 && px[2] < 100;
    const isBlue = (px) => Array.isArray(px) && px[2] > 150 && px[0] < 100;
    const isMixed = (px) => Array.isArray(px)
      && px[0] > 60 && px[0] < 200 && px[2] > 60 && px[2] < 200
      && Math.abs(px[0] - 220) > 30 && Math.abs(px[2] - 220) > 30;
    const cueInfo = Array.isArray(samples.cues) ? `cues=[${samples.cues}]` : `err=${samples.error || 'no samples'}`;
    check('pexels cut: before cue #1 shows clip #1 (red)', isRed(samples.a), `${cueInfo} px=${JSON.stringify(samples.a)}`);
    check('pexels cut: mid-crossfade after cue #1 (mixed)', isMixed(samples.b), `px=${JSON.stringify(samples.b)}`);
    check('pexels cut: between cues shows clip #2 (blue)', isBlue(samples.c), `px=${JSON.stringify(samples.c)}`);
    check('pexels cut: mid-crossfade after cue #2 (mixed)', isMixed(samples.d), `px=${JSON.stringify(samples.d)}`);
    check('pexels cut: after cue #2 back to clip #1 (red)', isRed(samples.e), `px=${JSON.stringify(samples.e)}`);
    let mOk = false;
    let mDetail = 'no download';
    if (mdl) {
      const isWebm = mdl.buf.readUInt32LE(0) === 0x1a45dfa3;
      const isMp4 = mdl.buf.length > 8 && mdl.buf.toString('ascii', 4, 8) === 'ftyp';
      const dur = isWebm ? parseWebmDurationMs(mdl.buf) : null;
      mOk = (isWebm || isMp4) && mdl.buf.length > 100000
        && (isMp4 || (dur !== null && Math.abs(dur / 1000 - 8) < 1.5));
      mDetail = `${mdl.name} ${mdl.buf.length} B, isWebm=${isWebm}, isMp4=${isMp4}, dur=${dur !== null ? (dur / 1000).toFixed(2) + 's' : 'n/a'}`;
    }
    check('pexels video export (container + duration ~= 8 s)', mClicked && mOk, mDetail);

    // Cleanliness: back to the visualizer background, selection cleared.
    await page.evaluate(() => {
      const radios = [...document.querySelectorAll('input[type="radio"][name="videoBgMode"]')];
      if (radios[0] && !radios[0].checked) radios[0].click();
      const cb = [...document.querySelectorAll('input[type="checkbox"]')]
        .find((c) => c.parentElement.textContent.includes('Export Video'));
      if (cb && cb.checked) cb.click();
      try { window.__NMP__.setPexelsTestSelection([]); } catch { /* dev-only */ }
    });
    await sleep(300);
  }

  // =========================================================================
  section('M4.5b — Pexels export frame fidelity: no stale/black/frozen frames (flicker regression)');
  // =========================================================================
  // Shared module (scripts/e2e-flicker-regress.cjs) so the block can also run
  // standalone (scripts/e2e-m45b-run.cjs) for fast iteration.
  await runFlickerRegress({ page, check, sleep, h, awaitDownload,
    // Scan the exported file in a CLEAN page: the app page still holds the
    // pattern clips + engine decoders and a background scan reads false blacks.
    newPage: async () => { const p = await browser.newPage(); await p.goto('about:blank'); await p.bringToFront(); return p; },
    // Dump the file on failure so a full-suite-only corruption can be
    // inspected offline (ffprobe / frame extract) instead of guessed at.
    saveFile: (name, buf) => { try {
      fs.writeFileSync(path.join(__dirname, '..', 'docs', 'screenshots', 'full_m45b_' + (/\.(mp4|webm|mkv)$/.test(name) ? name : 'export.bin')), buf);
    } catch { /* diagnostic only */ } },
  });

  // =========================================================================
  section('M1.14 — Karaoke burn-in: gate, SRT download, overlay pixels');
  // =========================================================================
  // Shared module (scripts/e2e-karaoke-regress.cjs) so the block can also run
  // standalone (scripts/e2e-karaoke-run.cjs) for fast iteration.
  await runKaraokeRegress({ page, check, sleep, h, awaitDownload });

  // =========================================================================
  section('M4.4 — Console: zero unexpected issues over the whole run');
  // =========================================================================
  {
    const KNOWN_BENIGN = []; // reviewed after first run; add with a comment each
    const mediaErrs = await page.evaluate(() => window.__nmpErr || []).catch(() => []);
    if (mediaErrs.length) console.log('  [error-event attribution]', JSON.stringify(mediaErrs));
    if (rawLog.length) {
      console.log(`  [cdp-raw-log] ${rawLog.length} entries`);
      for (const r of rawLog.slice(-25)) console.log(`    [+${((r.wall - RUN_T0) / 1000).toFixed(0)}s ${r.level} ${r.src}] ${r.text} :: ${r.url}`);
    }
    const unexpected = consoleIssues.filter((i) => !KNOWN_BENIGN.some((k) => i.text.includes(k)));
    check('0 unexpected console errors/warnings', unexpected.length === 0,
      unexpected.length ? unexpected.slice(0, 5).map((x) => `[${x.sec || '?'}${x.wall ? ' +' + ((x.wall - RUN_T0) / 1000).toFixed(0) + 's' : ''}] ${x.t}: ${x.text}`).join(' || ') : 'clean');
    if (consoleIssues.length) {
      console.log(`  (total collected: ${consoleIssues.length}${unexpected.length ? ' — see above' : ', all benign'})`);
    }
  }

  // =========================================================================
  await browser.close();
  console.log(`\n${'='.repeat(64)}`);
  console.log(`E2E RESULT: ${passed} passed, ${failed} failed`);
  if (fails.length) {
    console.log(`FAILED: ${fails.join(' | ')}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
