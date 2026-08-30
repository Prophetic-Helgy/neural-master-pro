/**
 * fps-measure.cjs — rAF frame-time measurement during Pro playback.
 *
 * Loads a 45 s test tone through the real file input, waits for the Faust
 * engine, starts playback, then samples requestAnimationFrame deltas in two
 * windows: the first 10 s after playback start (the "first-seconds stutter"
 * zone) and the remaining steady state. Acceptance: p95 <= 40 ms, no frames
 * > 100 ms in steady state.
 *
 * Run:  node scripts/fps-measure.cjs [url] [totalSeconds]
 *       (dev server must be up, default http://localhost:3000)
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

// Edge 152.0.4191.53 headless is broken on this box (exits 0 with no render);
// system Chrome works. Override with NMP_BROWSER.
const EDGE = process.env.NMP_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = process.argv[2] || 'http://localhost:3000/';
const TOTAL_SEC = Number(process.argv[3] || 30);
const TONE = path.join(__dirname, '..', 'docs', 'screenshots', 'fps_tone.wav');

/** 45 s stereo 44.1 kHz 16-bit WAV: 110/220/440 Hz chord, slow envelope. */
function writeToneWav(file) {
  const sr = 44100, dur = 45, n = sr * dur;
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const env = Math.min(1, t / 0.5) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.25 * t) ** 2);
    const s = (Math.sin(2 * Math.PI * 110 * t) * 0.4 + Math.sin(2 * Math.PI * 220 * t) * 0.3 + Math.sin(2 * Math.PI * 440 * t) * 0.2) * env * 0.7;
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 4);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s * 0.9)) * 32767), i * 4 + 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22);
  hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([hdr, pcm]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.evaluate(fn)) return true; } catch { /* page navigating */ }
    await sleep(300);
  }
  return false;
}

const INJECT_SNAPPER = () => {
  window.__fps = { deltas: [] };
  let last = performance.now();
  const tick = (now) => {
    window.__fps.deltas.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const READ_SNAPPER = () => {
  const d = [...window.__fps.deltas].sort((a, b) => a - b);
  const p = (q) => (d.length ? d[Math.min(d.length - 1, Math.floor(q * d.length))] : 0);
  return {
    n: d.length,
    p50: +p(0.5).toFixed(1),
    p95: +p(0.95).toFixed(1),
    max: +d[d.length - 1].toFixed(1),
    gt100: d.filter((x) => x > 100).length,
  };
};

(async () => {
  fs.mkdirSync(path.dirname(TONE), { recursive: true });
  writeToneWav(TONE);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();

  const consoleIssues = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') consoleIssues.push(msg.type() + ': ' + msg.text().slice(0, 200));
  });
  page.on('pageerror', (err) => consoleIssues.push('pageerror: ' + String(err).slice(0, 200)));

  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 90000 });
  if (!(await waitFor(page, () => !!document.querySelector('select'), 30000))) {
    console.error('FATAL: app did not mount'); await browser.close(); process.exit(1);
  }

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) { console.error('FATAL: no file input'); await browser.close(); process.exit(1); }
  await fileInput.uploadFile(TONE);
  const loaded = await waitFor(page, () => document.querySelectorAll('input[type="range"]').length > 10, 30000);
  const ready = await waitFor(page, () => /PROCESSING:\s*READY/i.test(document.body.innerText), 60000);
  console.log('track loaded:', loaded, '| engine ready:', ready);
  if (!ready) console.log('WARNING: engine not READY — measuring the dry-wire path');

  // Start playback (transport play button)
  const played = await page.evaluate(() => {
    const b = document.querySelector('button.w-12.h-12');
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  });
  console.log('play clicked:', played);
  await sleep(1000); // let the first frames settle

  // Window A: first 10 s of playback (first-seconds stutter zone)
  await page.evaluate(INJECT_SNAPPER);
  await sleep(10000);
  const windowA = await page.evaluate(READ_SNAPPER);

  // Window B: steady state (remainder of TOTAL_SEC)
  const steadySec = Math.max(5, TOTAL_SEC - 10);
  await page.evaluate(() => { window.__fps.deltas = []; });
  await sleep(steadySec * 1000);
  const windowB = await page.evaluate(READ_SNAPPER);

  console.log(JSON.stringify({
    url: APP_URL,
    engineReady: ready,
    first10s: windowA,
    steady: { ...windowB, seconds: steadySec },
    consoleIssues: consoleIssues.slice(0, 20),
  }, null, 2));

  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
