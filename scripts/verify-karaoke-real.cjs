/**
 * verify-karaoke-real.cjs — manual-quality verification of the REAL Whisper
 * path (not the M1.14 test seam): uploads a real speech clip, clicks the
 * actual "Recognize lyrics" UI, waits for bundled-model ASR, captures the
 * release screenshots (editor + karaoke style + a burned-in export frame)
 * and the .srt. Prints every recognized segment with timings for the report.
 *
 * Speech fixture: 10.4 s LibriSpeech sample (16 kHz mono), downloaded to
 *   <tmp>/asr_real.flac from https://huggingface.co/datasets/Narsil/asr_dummy
 * (dev-time test data — never shipped, never committed).
 *
 * Run: node scripts/verify-karaoke-real.cjs [url]   (dev server :3100)
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_APP = process.argv[2] || 'http://127.0.0.1:3100/';
const SAMPLE = path.join(os.tmpdir(), 'asr_real.flac');
const SHOTS = path.join(__dirname, '..', 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installDownloadHook(page) {
  return page.evaluate(() => {
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

(async () => {
  if (!fs.existsSync(SAMPLE)) { console.error('speech fixture missing:', SAMPLE); process.exit(2); }
  const browser = await puppeteer.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1280, height: 860 },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(600000);
  await page.goto(URL_APP, { waitUntil: 'networkidle2' });
  await installDownloadHook(page);
  const fileInput = await page.$('#track-upload');
  await fileInput.uploadFile(SAMPLE);
  const ready = await (async () => {
    const dl = Date.now() + 120000;
    while (Date.now() < dl) {
      try { if (await page.evaluate(() => { const e = window.__NMP__.getEngine(); return e.isReady() && !!e.faustNode && !!e.getBuffer(); })) return true; } catch { /* busy */ }
      await sleep(250);
    }
    return false;
  })();
  if (!ready) { console.error('engine not ready'); await browser.close(); process.exit(2); }
  console.log('track loaded, engine ready');

  // Open the export panel: Export Video on, Karaoke subtitles on.
  await page.evaluate(() => {
    const vcb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => c.parentElement.textContent.includes('Export Video'));
    if (vcb && !vcb.checked) vcb.click();
  });
  await sleep(300);
  await page.evaluate(() => {
    const kcb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => /karaoke subtitles/i.test(c.parentElement.textContent));
    if (kcb && !kcb.checked) kcb.click();
  });
  await sleep(200);

  // Click the real Recognize button and wait for the line editor (or error).
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^Recognize lyrics$/i.test(x.textContent.trim()) && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  });
  if (!clicked) { console.error('Recognize button not found/disabled'); await browser.close(); process.exit(2); }
  console.log('recognition started (bundled Whisper, first run loads the model)…');
  const t0 = Date.now();
  let lines = null;
  const deadline = Date.now() + 480000; // 8 min worst-case WASM CPU
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const err = [...document.querySelectorAll('p')].find((p) => p.className.includes('text-red-400'));
      const btn = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).find((x) => /Transcribing|Loading|model|engine/i.test(x));
      const rows = [...document.querySelectorAll('span')].filter((s) => /^\d+\.\d+–\d+\.\d+s$/.test(s.textContent.trim()));
      return { err: err ? err.textContent.trim() : null, phase: btn || null, rowCount: rows.length };
    });
    if (st.err) { console.error('ASR error in UI:', st.err); break; }
    if (st.rowCount > 0) {
      lines = await page.evaluate(() => [...document.querySelectorAll('span')]
        .filter((s) => /^\d+\.\d+–\d+\.\d+s$/.test(s.textContent.trim()))
        .map((s) => ({ time: s.textContent.trim(), text: s.parentElement.querySelector('input[type="text"]').value })));
      break;
    }
    if ((Date.now() - t0) % 10000 < 300) console.log(`  … ${(Date.now() - t0) / 1000 | 0}s (${st.phase || 'queued'})`);
    await sleep(500);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!lines) { console.error(`NO LINES after ${secs}s — ASR failed or returned empty`); await page.screenshot({ path: path.join(SHOTS, 'karaoke_verify_fail.png'), fullPage: false }); await browser.close(); process.exit(1); }
  console.log(`RECOGNIZED in ${secs}s: ${lines.length} segment(s)`);
  lines.forEach((l, i) => console.log(`  [${l.time}] ${l.text}`));

  // Screenshot 1: editor with recognized lines (scroll the line list into view).
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('span')].find((x) => /^\d+\.\d+–\d+\.\d+s$/.test(x.textContent.trim()));
    if (s) s.closest('div').parentElement.scrollIntoView({ block: 'center' });
  });
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, 'karaoke_editor.png') });

  // Screenshot 2: subtitle style selected — proves the toggle is live (the
  // karaoke view is already covered by karaoke_editor.png).
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('input[type="radio"][name="karaokeStyle"]')][1];
    if (r && !r.checked) { r.click(); r.scrollIntoView({ block: 'center' }); }
  });
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, 'karaoke_style_subs.png') });

  // Download the .srt through the real button.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /\.srt$/i.test(x.textContent.trim()) && x.textContent.toLowerCase().includes('download'));
    if (b) b.click();
  });
  let srt = null;
  const srtDeadline = Date.now() + 10000;
  while (!srt && Date.now() < srtDeadline) { srt = await takeDownload(page); if (!srt) await sleep(200); }
  if (srt) {
    fs.writeFileSync(path.join(os.tmpdir(), 'karaoke_real.srt'), srt.buf);
    console.log(`SRT downloaded: ${srt.name} (${srt.buf.length} B)`);
    console.log(srt.buf.toString('utf8').split('\n').slice(0, 8).join('\n'));
  } else console.log('WARN: no .srt download captured');

  // Export (audio + video with burn-in) — grab the hidden export canvas mid
  // first-line for a burned-in screenshot, then drain downloads.
  const first = lines[0];
  const [fs1, fe1] = first.time.split('–').map((x) => parseFloat(x));
  const grab = page.evaluate(async (a, b) => {
    const findCanvas = () => [...document.querySelectorAll('canvas')]
      .find((c) => { let el = c.parentElement; while (el) { if (el.style && el.style.top === '-9999px') return true; el = el.parentElement; } return false; });
    let best = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const t = window.__NMP__.getEngine().getCurrentTime();
      const cv = findCanvas();
      if (cv && t >= a + 0.3 && t <= b - 0.2) return cv.toDataURL('image/png');
      if (cv && t > b + 3) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
    return best;
  }, fs1, fe1);
  const expClicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^(Export|Recording Video\.\.\.)$/.test(x.textContent.trim()) && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  });
  console.log('export clicked:', expClicked);
  const png = await grab;
  if (png && png.startsWith('data:image/png')) {
    fs.writeFileSync(path.join(SHOTS, 'karaoke_burnin_frame.png'), Buffer.from(png.split(',')[1], 'base64'));
    console.log('burn-in frame captured -> docs/screenshots/karaoke_burnin_frame.png');
  } else console.log('WARN: no burn-in frame grabbed');

  // Drain remaining downloads (audio, video, auto-srt) — just log names.
  const drainDeadline = Date.now() + 150000;
  while (Date.now() < drainDeadline) {
    const d = await takeDownload(page);
    if (d) console.log('download drained:', d.name, `(${d.buf.length} B)`);
    else if (await page.evaluate(() => !document.body.innerText.includes('Recording Video'))) break;
    await sleep(400);
  }

  await browser.close();
  console.log(lines.length > 0 ? 'REAL-ASR VERIFY: PASS' : 'REAL-ASR VERIFY: FAIL');
  process.exit(0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
