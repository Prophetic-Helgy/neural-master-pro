/**
 * screens.cjs — release screenshots for docs/screenshots/ via
 * puppeteer-core + the system Edge (no Chrome download).
 *
 * Run:  node scripts/screens.cjs     (dev server on http://localhost:3000 must be up)
 *
 * 5 frames: 01 Pro mixer (default mode) · 02 Lite after mastering
 * (Before/After + findings) · 03 Batch + export panel (AAC) ·
 * 04 A/B compare + metrics · 05 RU localization.
 * Each shot is independent (try/catch); failures are reported at the end.
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

// Edge 152.0.4191.53 headless is broken on this box (exits 0 with no render);
// system Chrome works. Override with NMP_BROWSER.
const EDGE = process.env.NMP_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:3000/';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const TONE = path.join(OUT_DIR, 'tone_test.wav');

/** 10 s stereo 44.1 kHz 16-bit WAV: 110/220/440 Hz chord, in/out envelope. */
function writeToneWav(file) {
  const sr = 44100, dur = 10, n = sr * dur;
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const env = Math.min(1, t / 0.5) * Math.min(1, (dur - t) / 1.5);
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

const clickButton = (page, label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim().toUpperCase() === l && !x.disabled);
  if (b) { b.click(); return true; }
  return false;
}, label);

/**
 * Click the Lite-mode MASTER action. The transport has a monitor button also
 * labeled "MASTER" earlier in document order, so scope the search to the
 * "LITE MASTER" panel (smallest containing div first, then walk up).
 */
const clickLiteMaster = (page) => page.evaluate(() => {
  const panels = [...document.querySelectorAll('div')]
    .filter((d) => /LITE MASTER/i.test(d.innerText))
    .sort((a, b) => a.innerText.length - b.innerText.length);
  for (const panel of panels) {
    const b = [...panel.querySelectorAll('button')].find((x) => x.innerText.trim().toUpperCase() === 'MASTER' && !x.disabled);
    if (b) { b.click(); return true; }
  }
  return false;
});

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeToneWav(TONE);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const results = {};
  const shot = async (name) => {
    try { await page.screenshot({ path: path.join(OUT_DIR, name) }); results[name] = 'OK'; }
    catch (e) { results[name] = 'FAIL: ' + e.message; }
  };

  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 90000 });
  if (!(await waitFor(page, () => !!document.querySelector('select'), 30000))) {
    console.error('FATAL: app did not mount');
    await browser.close();
    process.exit(1);
  }
  console.log('app mounted');

  // Load the test tone through the real file input
  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) { console.error('FATAL: no file input'); await browser.close(); process.exit(1); }
  await fileInput.uploadFile(TONE);
  const loaded = await waitFor(page, () => document.querySelectorAll('input[type="range"]').length > 10, 30000);
  console.log('track loaded:', loaded);
  // Wait for the DSP engine to finish initializing ("PROCESSING: READY" in footer)
  const ready = await waitFor(page, () => /PROCESSING:\s*READY/i.test(document.body.innerText), 60000);
  console.log('engine ready:', ready);
  await sleep(3000); // meters moving

  // 01 — Pro mixer (default mode)
  await shot('01-pro-mixer.png');

  // 02 — Lite: switch, run mastering, Before/After + findings
  try {
    await clickButton(page, 'LITE');
    await waitFor(page, () => /LITE/i.test(document.body.innerText), 8000);
    await sleep(1000);
    const clicked = await clickLiteMaster(page);
    console.log('lite master clicked:', clicked);
    const done = await waitFor(page, () => /MASTERED/i.test(document.body.innerText), 90000);
    console.log('mastering done:', done);
    await sleep(1500);
    await shot('02-lite-after.png');
  } catch (e) { results['02-lite-after.png'] = 'FAIL: ' + e.message; }

  // 04 — A/B compare + export row. Captured while still in Lite, right after
  // mastering: switching to Pro unmounts LiteMaster and drops the render.
  // The app is a fixed h-screen layout that clips overflow, so widen the
  // viewport instead of scrolling to fit the whole panel.
  try {
    await page.setViewport({ width: 1440, height: 1080 });
    await sleep(600);
    await shot('04-ab-metrics.png');
    await page.setViewport({ width: 1440, height: 900 });
    await sleep(300);
  } catch (e) { results['04-ab-metrics.png'] = 'FAIL: ' + e.message; }

  // 03 — Batch + export panel with AAC selected
  try {
    await clickButton(page, 'PRO');
    await sleep(1500);
    const selects = await page.$$('select');
    for (const s of selects) {
      const html = await s.evaluate((el) => el.innerHTML);
      if (/value="wav"/.test(html)) { await s.select('aac'); break; }
    }
    await sleep(3000); // let the local ffmpeg core pre-load
    await shot('03-batch-export.png');
  } catch (e) { results['03-batch-export.png'] = 'FAIL: ' + e.message; }

  // 05 — RU localization
  try {
    await clickButton(page, 'RU');
    await sleep(1500);
    await shot('05-i18n-ru.png');
  } catch (e) { results['05-i18n-ru.png'] = 'FAIL: ' + e.message; }

  await browser.close();
  console.log('SCREENS:', JSON.stringify(results, null, 2));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
