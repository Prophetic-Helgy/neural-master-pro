/**
 * e2e-m45b-repro.cjs — reproduce the full-e2e M4.5b failure in isolation:
 * run an M4.5-like pexels export cycle (2 clips + cleanup) FIRST, then the
 * shared flicker regress. The full-suite run failed with cues=[] while the
 * standalone M4.5b run passed — this harness tests whether the M4.5 cycle's
 * state (cleanup, download queue, radio) is what breaks it.
 *
 * Run: node scripts/e2e-m45b-repro.cjs [url]
 */
const puppeteer = require('puppeteer-core');
const { runFlickerRegress } = require('./e2e-flicker-regress.cjs');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_APP = process.argv[2] || 'http://127.0.0.1:3100/';
const TONE = path.join(__dirname, '..', 'docs', 'screenshots', 'e2e_tone.wav');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failed += 1;
}

const h = (page, name, ...args) => page.evaluate(
  (n, a) => window.__h[n](...a), name, args
);

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
async function waitFor(page, fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await page.evaluate(fn)) return true; } catch { /* page busy */ }
    await sleep(250);
  }
  return false;
}
async function awaitDownload(page, ms = 120000) {
  const ok = await waitFor(page, () => window.__nmpDl.items.some((x) => x.taken && !x.read), ms);
  return ok ? takeDownload(page) : null;
}

// Record 2 flat-color webm clips (M4.5 style) and return their object URLs.
async function recordTwoClips(page) {
  return page.evaluate(async () => {
    const rec = async (color) => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 360;
      const x = c.getContext('2d');
      const v = document.createElement('video');
      const stream = c.captureStream(30);
      const mr = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((r) => { mr.onstop = r; });
      mr.start();
      let stop = false;
      const paint = () => { x.fillStyle = color; x.fillRect(0, 0, 640, 360); if (!stop) requestAnimationFrame(paint); };
      paint();
      await new Promise((r) => setTimeout(r, 2500));
      stop = true; mr.stop(); await done;
      const blob = new Blob(chunks, { type: 'video/webm' });
      return URL.createObjectURL(blob);
    };
    return [await rec('#ff0000'), await rec('#0000ff')];
  });
}

(async () => {
  if (!fs.existsSync(TONE)) { console.error('tone fixture missing:', TONE); process.exit(2); }
  const browser = await puppeteer.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 300)));
  await page.goto(URL_APP, { waitUntil: 'networkidle2' });
  await installDownloadHook(page);
  const fileInput = await page.$('#track-upload');
  await fileInput.uploadFile(TONE);
  const ready = await waitFor(page, () => {
    try { const e = window.__NMP__.getEngine(); return e.isReady() && !!e.faustNode; } catch { return false; }
  }, 120000);
  if (!ready) { console.error('engine not ready'); await browser.close(); process.exit(2); }
  console.log('app up (' + URL_APP + ')');
  await page.evaluate(() => {
    const inputSet = (el, value) => {
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    const clickText = (text) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === text && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    };
    window.__h = { inputSet, clickText };
  });

  // ---- M4.5-like cycle: 2 clips, Pexels radio, END=8, export, cleanup ----
  const urls = await recordTwoClips(page);
  console.log('  2 clips recorded', urls.length);
  await page.evaluate((u) => {
    window.__NMP__.setPexelsTestSelection(u.map((url) => ({ url, author: 'tester' })));
  }, urls);
  await page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[type="radio"][name="videoBgMode"]')];
    const r = radios.find((x) => (x.parentElement.textContent || '').toLowerCase().includes('pexels')) || radios[1];
    if (r && !r.checked) r.click();
    const lab = [...document.querySelectorAll('label')].find((l) => l.textContent.trim().toUpperCase().startsWith('END'));
    const inp = lab.parentElement.querySelector('input[type="number"]');
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    proto.call(inp, '8'); inp.dispatchEvent(new Event('input', { bubbles: true }));
    const cb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => c.parentElement.textContent.includes('Export Video'));
    if (cb && !cb.checked) cb.click();
  });
  await sleep(500);
  await h(page, 'clickText', 'Export');
  const dlDeadline = Date.now() + 180000;
  let sawVid = false;
  while (!sawVid && Date.now() < dlDeadline) {
    const d = await awaitDownload(page, 20000);
    if (!d) continue;
    sawVid = d.buf.length > 8 && (d.buf.readUInt32BE(0) === 0x1a45dfa3 || d.buf.toString('ascii', 4, 8) === 'ftyp');
  }
  check('repro: M4.5-style export downloaded a video', sawVid);
  await page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[type="radio"][name="videoBgMode"]')];
    if (radios[0] && !radios[0].checked) radios[0].click();
    const cb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => c.parentElement.textContent.includes('Export Video'));
    if (cb && cb.checked) cb.click();
    try { window.__NMP__.setPexelsTestSelection([]); } catch { /* dev-only */ }
  });
  await sleep(500);
  // ---- now the shared M4.5b regress, in this exact state ----
  await runFlickerRegress({ page, check, sleep, h, awaitDownload,
    newPage: async () => { const p = await browser.newPage(); await p.goto('about:blank'); await p.bringToFront(); return p; },
    saveFile: (name, buf) => fs.writeFileSync(path.join(__dirname, '..', 'docs', 'screenshots',
      'repro_' + (/\.(mp4|webm|mkv)$/.test(name) ? name : 'export.bin')), buf),
  });

  console.log('page errors:', pageErrors.length ? pageErrors.join(' || ') : 'none');
  await browser.close();
  console.log(failed === 0 ? 'REPRO: all green (no repro)' : `REPRO: ${failed} FAILED (reproduced)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
