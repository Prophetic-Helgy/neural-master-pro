/**
 * e2e-m45-repro.cjs — standalone repro of the M4.5 black-tail defect.
 * 2 short flat-color clips + 8 s region + real peak cues; while the export
 * runs, a tracer samples every bg video (currentTime/readyState/paused)
 * against the engine clock. Dumps the exported file next to the trajectory.
 *
 * Run: node scripts/e2e-m45-repro.cjs [url]   (dev server :3100 expected)
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_APP = process.argv[2] || 'http://127.0.0.1:3100/';
const TONE = path.join(__dirname, '..', 'docs', 'screenshots', 'e2e_tone.wav');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'm45_repro_export.mp4');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(TONE)) { console.error('tone fixture missing:', TONE); process.exit(2); }
  const browser = await puppeteer.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  // download hook (mirrors e2e.cjs)
  await page.evaluateOnNewDocument(() => {
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
  page.on('pageerror', (e) => console.log('  [pageerror] ' + String(e.message || e).slice(0, 200)));

  await page.goto(URL_APP, { waitUntil: 'networkidle2' });
  const fileInput = await page.$('#track-upload');
  await fileInput.uploadFile(TONE);
  const ready = await (async () => {
    const dl = Date.now() + 120000;
    while (Date.now() < dl) {
      try {
        if (await page.evaluate(() => { const e = window.__NMP__.getEngine(); return e.isReady() && !!e.faustNode; })) return true;
      } catch { /* busy */ }
      await sleep(250);
    }
    return false;
  })();
  if (!ready) { console.error('engine not ready'); await browser.close(); process.exit(2); }
  console.log('app up');

  // in-page helpers
  await page.evaluate(() => {
    const inputSet = (el, value) => {
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    const clickText = (text) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === text && !x.disabled);
      if (!b) return false;
      b.click(); return true;
    };
    window.__h = { inputSet, clickText };
  });

  // 2 synthetic 1.2 s clips — same generator as e2e.cjs M4.5
  const clipInfo = await page.evaluate(async () => {
    const make = (style) => new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 180;
      const cx = c.getContext('2d');
      cx.fillStyle = style; cx.fillRect(0, 0, 320, 180);
      let frame = 0;
      const tick = () => { frame += 1; cx.fillStyle = 'rgba(0,0,0,0.4)'; cx.fillRect((frame * 7) % 318, 0, 2, 2); };
      const stream = c.captureStream(30);
      const iv = setInterval(tick, 100);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = () => { clearInterval(iv); stream.getTracks().forEach((tr) => tr.stop()); resolve(URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }))); };
      rec.start(250);
      setTimeout(() => rec.stop(), 1200);
    });
    const red = await make('rgb(220,20,30)');
    const blue = await make('rgb(30,20,220)');
    // measure durations once
    const durs = await Promise.all([red, blue].map((u) => new Promise((res) => {
      const v = document.createElement('video');
      v.preload = 'auto'; v.src = u;
      v.onloadedmetadata = () => res(+v.duration.toFixed(3));
      v.onerror = () => res(-1);
    })));
    return { urls: [red, blue], durs };
  });
  console.log('clips ready, durations:', clipInfo.durs);

  await page.evaluate(() => {
    const cb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => c.parentElement.textContent.includes('Export Video'));
    if (cb && !cb.checked) cb.click();
  });
  await sleep(300);
  await page.evaluate((urls) => window.__NMP__.setPexelsTestSelection([
    { url: urls[0], author: 'Red Author' },
    { url: urls[1], author: 'Blue Author' },
  ]), clipInfo.urls);
  await page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[type="radio"][name="videoBgMode"]')];
    if (!radios[1].checked) radios[1].click();
  });
  await page.evaluate(() => {
    const lab = [...document.querySelectorAll('label')].find((l) => l.textContent.trim().toUpperCase().startsWith('END'));
    const inp = lab.parentElement.querySelector('input[type="number"]');
    window.__h.inputSet(inp, 8);
  });
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'wav'));
    window.__h.inputSet(sel, 'wav');
  });
  await sleep(400);

  // drain anything stale, then start the tracer + export
  await page.evaluate(() => { window.__nmpDl.items.forEach((x) => { x.read = true; }); });
  await page.evaluate(() => {
    window.__trace = [];
    const eng = () => { try { return window.__NMP__.getEngine().getCurrentTime(); } catch { return -1; } };
    const tick = () => {
      const vs = window.__NMP__.getBgVideos();
      if (vs && vs.length) {
        window.__trace.push({
          t: +eng().toFixed(3),
          v: vs.map((x, i) => `${i}${(+x.currentTime).toFixed(2)}/${x.readyState}/${x.paused ? 'P' : '>'}/${x.videoWidth}`),
        });
      }
      window.__traceTimer = setTimeout(tick, 66);
    };
    tick();
  });

  await page.evaluate(() => { window.__h.clickText('Export'); });
  console.log('export clicked');
  const deadline = Date.now() + 240000;
  let got = null;
  while (Date.now() < deadline && !got) {
    // audio WAV lands first — only the video download ends the wait
    const idx = await page.evaluate(() => window.__nmpDl.items.findIndex(
      (x) => x.taken && !x.read && /\.(mp4|webm|m4v)$/i.test(x.name || '')));
    if (idx >= 0) {
      got = await page.evaluate(async (i) => {
        const it = window.__nmpDl.items[i];
        it.read = true;
        const ab = await it.blob.arrayBuffer();
        const u8 = new Uint8Array(ab);
        let bin = '';
        for (let j = 0; j < u8.length; j += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(j, j + 0x8000));
        return { name: it.name, b64: bin.length && btoa(bin), size: u8.length };
      }, idx);
    } else await sleep(300);
  }
  await page.evaluate(() => clearTimeout(window.__traceTimer));
  if (!got) { console.error('no download'); await browser.close(); process.exit(2); }
  fs.writeFileSync(OUT, Buffer.from(got.b64, 'base64'));
  console.log('saved', got.name, got.size, 'B ->', OUT);

  const trace = await page.evaluate(() => window.__trace);
  await browser.close();

  // print trajectory: readyState/pause/width changes + loop wraps, per clip
  const nVid = Math.max(...trace.map((s) => s.v.length), 0);
  for (let ci = 0; ci < nVid; ci += 1) {
    console.log(`--- clip ${ci} ---`);
    let prev = '';
    let prevCt = -1;
    for (const s of trace) {
      const f = (s.v[ci] || '').split('/');
      const ct = parseFloat(f[0]);
      const sig = f.slice(1).join('/');
      const wrapped = prevCt >= 0 && ct < prevCt - 0.01;
      if (sig !== prev || wrapped) {
        console.log(`t=${s.t.toFixed(2)} ct=${ct.toFixed(2)} ${sig}${wrapped ? '  <<WRAP' : ''}`);
        prev = sig;
      }
      if (!wrapped && isFinite(ct)) prevCt = Math.max(prevCt, ct);
      if (wrapped) prevCt = ct;
    }
  }
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
