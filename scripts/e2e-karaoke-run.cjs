/**
 * e2e-karaoke-run.cjs — standalone runner for the KARAOKE burn-in (M1.14)
 * block (shared module scripts/e2e-karaoke-regress.cjs), for fast iteration
 * without the full e2e suite (~2 min vs ~16 min). Requires dev server :3100.
 *
 * Run: node scripts/e2e-karaoke-run.cjs [url]
 */
const puppeteer = require('puppeteer-core');
const { runKaraokeRegress } = require('./e2e-karaoke-regress.cjs');
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
    // the two in-page helpers the regress module uses (same as e2e.cjs)
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
  await runKaraokeRegress({ page, check, sleep, h, awaitDownload });
  await browser.close();
  console.log(failed === 0 ? 'KARAOKE STANDALONE: all green' : `KARAOKE STANDALONE: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
