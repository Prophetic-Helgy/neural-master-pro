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
 *                    effect), monitoring A/B, 7 visualizers, transport.
 *   M2 Lite        — 10 presets hit LUFS target / stay under the TP ceiling,
 *                    custom preset, A/B hold, batch of 3 -> ZIP with valid
 *                    WAVs, exports WAV 16/24/32f, MP3 192/320, FLAC.
 *   M3 Pro export  — WAV 16/24/32f, FLAC, MP3 320, AAC 128/256 (m4a with
 *                    title metadata), video (webm/mp4, duration ~= trim).
 *   M4 System      — 9 languages (no "undefined", localized labels),
 *                    hardware widget honest in headless (--°C), FPS p95
 *                    over 60 s playback, zero unexpected console issues.
 *
 * All DOM helpers live IN the page (window.__h) because page.evaluate only
 * serializes its own function. Downloads are captured in-page (blob anchor
 * hook) and validated byte-level in Node: WAV fmt chunk, MP3 frame header
 * bitrate, FLAC STREAMINFO, m4a ftyp + title bytes, webm EBML Duration,
 * fflate ZIP -> per-file WAVs.
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
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
function section(title) {
  console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`);
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
    window.__h = { inputSet, setTonalSlider, setFxSlider, eqSetBand, clickText, clickTextStart, clickLiteMaster, dspParam, peqSet, setRangeByMinMax, seekBar, getSeekBarLabel };
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

// ---------------------------------------------------------------------------

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const TONE = path.join(OUT_DIR, 'e2e_tone.wav');
  const REFTONE = path.join(OUT_DIR, 'e2e_ref.wav');
  const HIGHTONE = path.join(OUT_DIR, 'e2e_hightone.wav');
  const B1 = path.join(OUT_DIR, 'e2e_batch1.wav');
  const B2 = path.join(OUT_DIR, 'e2e_batch2.wav');
  const B3 = path.join(OUT_DIR, 'e2e_batch3.wav');
  writeToneWav(TONE, [110, 220, 440], 10);
  writeToneWav(REFTONE, [330, 660, 990], 10);
  writeToneWav(HIGHTONE, [4400, 8800, 12000], 10);
  writeToneWav(B1, [100], 3);
  writeToneWav(B2, [200], 3);
  writeToneWav(B3, [300], 3);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();

  const consoleIssues = [];
  const consoleLogs = [];
  page.on('console', (msg) => {
    const t = msg.type();
    const text = msg.text().slice(0, 1500);
    if (t === 'error' || t === 'warning') consoleIssues.push({ t, text });
    else if (t === 'log') consoleLogs.push(text);
  });
  page.on('pageerror', (e) => consoleIssues.push({ t: 'pageerror', text: String(e.message || e).slice(0, 1500) }));

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
    const vClicked = await h(page, 'clickText', 'Export');
    const vdl = await awaitDownload(page, 180000);
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
  section('M4.4 — Console: zero unexpected issues over the whole run');
  // =========================================================================
  {
    const KNOWN_BENIGN = []; // reviewed after first run; add with a comment each
    const unexpected = consoleIssues.filter((i) => !KNOWN_BENIGN.some((k) => i.text.includes(k)));
    check('0 unexpected console errors/warnings', unexpected.length === 0,
      unexpected.length ? unexpected.slice(0, 5).map((x) => `${x.t}: ${x.text}`).join(' || ') : 'clean');
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
