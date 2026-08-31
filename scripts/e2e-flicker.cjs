/**
 * e2e-flicker.cjs — DIAGNOSTIC probe for the Pexels-export flicker (v2.6).
 *
 * Run:  node scripts/e2e-flicker.cjs [url]     (dev server, default :3100)
 *
 * Reproduce the user-visible bug objectively, at realistic load: FOUR
 * synthetic 720p H.264 background clips (mp4 via MediaRecorder — the same
 * decode path as real Pexels clips) painted with a 4-color palette that
 * changes every 0.4 s (2-s pattern), lengths 2.4/3.2/4.8/6.4 s so their loop
 * wraps land at different phases against the peak cues; 40 s export.
 *
 * Because the clip content is deterministic, the EXPECTED color at file time
 * t is computable — clip (k%4) shows palette[floor(((t+d) mod len)/0.4)%4],
 * and the unknown play-start offset d is calibrated by correlation. Every
 * file sample (10 Hz seek scan of the downloaded mp4) is then classified:
 *   BLACK   — near-black frame where the pattern can never be (decoder fail)
 *   STALE   — the previous pattern color (drawImage served a stale frame,
 *             the classic loop-wrap artifact)
 *   FREEZE  — same color for >0.7 s (stalled feed)
 *   OK      — matches the expected palette slot
 * Cross-checked against the live canvas trace (draw side vs capture side)
 * and per-video currentTime wrap events from the in-page trace.
 *
 * Output: console table + docs/screenshots/flicker_probe.json.
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.NMP_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = process.argv[2] || 'http://127.0.0.1:3100/';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRACK_SEC = 40;
const PALETTE = [
  [235, 40, 50],   // red
  [235, 235, 235], // white
  [60, 90, 240],   // blue
  [40, 210, 110],  // green
];
const SLOT_MS = 400; // palette changes every 0.4 s → 2-s pattern period
const CLIP_LENS = [2.4, 3.2, 4.8, 6.4];
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const classify = (rgb) => {
  let best = 0, bd = Infinity;
  for (let i = 0; i < PALETTE.length; i += 1) {
    const d = (PALETTE[i][0] - rgb[0]) ** 2 + (PALETTE[i][1] - rgb[1]) ** 2 + (PALETTE[i][2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};

function writeToneWav(file, freqs, dur, sr = 44100) {
  const n = sr * dur;
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const env = Math.min(1, t / 0.5) * Math.min(1, (dur - t) / 1.5);
    let s = 0;
    for (let k = 0; k < freqs.length; k += 1) s += (Math.sin(2 * Math.PI * freqs[k] * t) * 0.4) / freqs.length;
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

async function takeDownload(page, ms = 240000, predicate = () => true) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const idx = await page.evaluate(() => {
      const i = window.__nmpDl.items.findIndex((x) => x.taken && !x.read);
      if (i >= 0) window.__nmpDl.items[i].read = true;
      return i;
    });
    if (idx >= 0) {
      const [b64, name] = await page.evaluate(async (i) => {
        const it = window.__nmpDl.items[i];
        const ab = await it.blob.arrayBuffer();
        const u8 = new Uint8Array(ab);
        let bin = '';
        for (let j = 0; j < u8.length; j += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(j, j + 0x8000));
        return [btoa(bin), it.name];
      }, idx);
      const buf = Buffer.from(b64, 'base64');
      if (predicate(buf)) return { name, buf };
      continue; // e.g. the audio WAV that precedes the video download
    }
    await sleep(500);
  }
  return null;
}

const isVideoContainer = (buf) =>
  (buf.length > 4 && buf.readUInt32LE(0) === 0x1a45dfa3)
  || (buf.length > 8 && buf.toString('ascii', 4, 8) === 'ftyp');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const TONE = path.join(OUT_DIR, 'e2e_flicker_tone.wav');
  writeToneWav(TONE, [110, 220, 440], TRACK_SEC);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [console.error] ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await installDownloadHook(page);

  const fileInput = await page.$('#track-upload');
  await fileInput.uploadFile(TONE);
  const engineUp = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      try {
        if (await page.evaluate(() => { const e = window.__NMP__.getEngine(); return e.isReady() && !!e.faustNode; })) return true;
      } catch { /* loading */ }
      await sleep(500);
    }
    return false;
  })();
  if (!engineUp) { console.error('engine never came up'); await browser.close(); process.exit(2); }
  console.log(`app up (${APP_URL})`);

  // --- 4 pattern clips, 1280×720, h264 mp4 when supported (real decode
  //     path of Pexels clips), 2.4/3.2/4.8/6.4 s lengths.
  // recorder "warmer": Chrome's avc1/mp4 recorder yields empty clips on the
  // first cold attempts — record+discard two short primers before real clips.
  const clipUrls = await page.evaluate(async (lens) => {
    const PALETTE = [[235, 40, 50], [235, 235, 235], [60, 90, 240], [40, 210, 110]];
    const pickMime = () => (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')
      ? 'video/mp4;codecs=avc1' : 'video/webm');
    const recOnce = (lenSec, mime) => new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 720;
      const cx = c.getContext('2d');
      const t0 = performance.now();
      const paint = () => {
        const el = performance.now() - t0;
        const idx = Math.floor((el % 1600) / 400) % 4;
        cx.fillStyle = `rgb(${PALETTE[idx][0]},${PALETTE[idx][1]},${PALETTE[idx][2]})`;
        cx.fillRect(0, 0, 1280, 720);
      };
      paint();
      const stream = c.captureStream(30);
      const iv = setInterval(paint, 60);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
      const chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onerror = () => { /* surfaces as 0-byte result → retry */ };
      rec.onstop = () => {
        clearInterval(iv);
        stream.getTracks().forEach((tr) => tr.stop());
        resolve({ url: URL.createObjectURL(new Blob(chunks, { type: mime })), mime, bytes: chunks.reduce((s, x) => s + x.size, 0) });
      };
      rec.start(500);
      setTimeout(() => { try { rec.stop(); } catch { /* resolve via onstop anyway */ } }, Math.round(lenSec * 1000));
    });
    // prime the recorder pipeline (throwaway), then retry real clips until bytes > 0
    for (let w = 0; w < 2; w += 1) await recOnce(0.3, pickMime());
    const out = [];
    for (const len of lens) {
      let got = null;
      for (let tries = 0; tries < 4 && (!got || got.bytes < 10000); tries += 1) {
        got = await recOnce(len, pickMime());
      }
      out.push(got);
    }
    return { clips: out.map((o) => ({ url: o.url, bytes: o.bytes })), mime: out[0].mime };
  }, CLIP_LENS);
  console.log(`clips: ${clipUrls.clips.map((c, i) => `${CLIP_LENS[i]}s/${c.bytes}B`).join(' ')} (${clipUrls.mime})`);
  if (clipUrls.clips.some((c) => c.bytes < 10000)) {
    console.error('a clip recorded empty after retries — cannot test at realistic load');
    await browser.close();
    process.exit(2);
  }

  // --- arm export: video ON, Pexels bg, 4-clip fake selection, wav audio.
  await page.evaluate(() => {
    const cb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => c.parentElement.textContent.includes('Export Video'));
    if (cb && !cb.checked) cb.click();
  });
  await sleep(300);
  const armed = await page.evaluate((urls) => {
    const selOk = window.__NMP__.setPexelsTestSelection(
      urls.map((u, i) => ({ url: u, author: `A${i}` })),
    );
    const radios = [...document.querySelectorAll('input[type="radio"][name="videoBgMode"]')];
    if (radios[1] && !radios[1].checked) radios[1].click();
    const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'wav'));
    if (sel) {
      const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      set.call(sel, 'wav');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return selOk === true && radios.length >= 2;
  }, clipUrls.clips.map((c) => c.url));
  if (!armed) { console.error('failed to arm pexels export'); await browser.close(); process.exit(2); }
  await sleep(500);

  // --- live trace (draw side): canvas mean color + per-video readyState/ct.
  const tracePromise = page.evaluate(async (trackSec) => {
    const trace = [];
    const findCanvas = () => [...document.querySelectorAll('canvas')]
      .find((c) => { let el = c.parentElement; while (el) { if (el.style && el.style.top === '-9999px') return true; el = el.parentElement; } return false; });
    const off = document.createElement('canvas'); off.width = 32; off.height = 18;
    const ox = off.getContext('2d', { willReadFrequently: true });
    const e = window.__NMP__.getEngine();
    const t0 = Date.now();
    let vids = [];
    while (Date.now() - t0 < 30000) {
      try { vids = window.__NMP__.getBgVideos(); } catch { vids = []; }
      if (vids.length === 4 && vids.every((v) => v.readyState >= 2)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (vids.length !== 4) return { error: `bg videos not ready (got ${vids.length})`, trace };
    const deadline = Date.now() + 240000;
    let idleSince = 0, lastT = -1;
    while (Date.now() < deadline) {
      const t = e.getCurrentTime();
      if (t > trackSec - 0.1 || (t > 0.5 && Math.abs(t - lastT) < 0.001 && Date.now() - idleSince > 4000)) break;
      if (Math.abs(t - lastT) >= 0.001) { lastT = t; idleSince = Date.now(); }
      const cv = findCanvas();
      let px = null;
      if (cv) {
        ox.drawImage(cv, 0, 0, 32, 18);
        const d = ox.getImageData(0, 0, 32, 18).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        px = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      }
      trace.push({ t: +t.toFixed(3), px, vs: vids.map((v) => [v.readyState, +(v.currentTime || 0).toFixed(3)]) });
      await new Promise((r) => setTimeout(r, 80));
    }
    return { trace };
  }, TRACK_SEC);

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Export' && !x.disabled);
    if (b) b.click();
  });

  const dl = await takeDownload(page, 240000, isVideoContainer);
  const tr = await tracePromise;
  const cues = await page.evaluate(() => (window.__NMP__.getExportBgCues() || []).map((x) => +x.toFixed(3)));
  if (!dl) { console.error('no export video download captured'); await browser.close(); process.exit(2); }
  if (tr.error) console.log(`NOTE trace: ${tr.error}`);
  const isMp4 = dl.buf.length > 8 && dl.buf.toString('ascii', 4, 8) === 'ftyp';
  console.log(`download: ${dl.name} ${(dl.buf.length / 1e6).toFixed(1)} MB (${isMp4 ? 'mp4' : 'webm'}); cues n=${cues.length} [${cues.join(',')}]`);

  // --- file scan at 10 Hz.
  const b64 = dl.buf.toString('base64');
  const fileScan = await page.evaluate(async (b64s, blobMime) => {
    const bin = atob(b64s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([u8], { type: blobMime }));
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = url;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('decode fail')); });
    const dur = v.duration;
    const off = document.createElement('canvas'); off.width = 32; off.height = 18;
    const ox = off.getContext('2d', { willReadFrequently: true });
    const scan = [];
    for (let t = 0; t < dur; t += 0.1) {
      await new Promise((res) => {
        let done = false;
        const to = setTimeout(() => { if (!done) { done = true; res(); } }, 800);
        v.onseeked = () => { if (!done) { done = true; clearTimeout(to); res(); } };
        try { v.currentTime = t; } catch { if (!done) { done = true; clearTimeout(to); res(); } }
      });
      ox.drawImage(v, 0, 0, 32, 18);
      const d = ox.getImageData(0, 0, 32, 18).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      scan.push({ t: +v.currentTime.toFixed(2), rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)] });
    }
    URL.revokeObjectURL(url);
    v.removeAttribute('src'); v.load();
    return { dur, scan };
  }, b64, isMp4 ? 'video/mp4;codecs=avc1' : 'video/webm');
  console.log(`file scan: dur=${fileScan.dur.toFixed(2)}s samples=${fileScan.scan.length}`);

  // =========================================================================
  // MODEL-FREE validation. After the play-control fix each clip's wall-time
  // phase no longer tracks the export clock (inactive clips pause), so any
  // wall-based expected-color model is invalid. Instead:
  //   ground truth = each <video>'s OWN currentTime (in the live trace) —
  //   the drawn frame must match palette[(ct + p_i) mod len] for the clip on
  //   screen. p_i (recorder-start vs pattern offset) is calibrated per clip.
  //   DRAW mismatch = stale/late/black frame. Then the FILE is aligned to the
  //   canvas timeline by a time shift (capture offset) and compared — file
  //   mismatch = encoder/capture fault, file BLACK = decoder fail.
  // =========================================================================
  const inFade = (t) => cues.some((c) => t - c >= -0.1 && t - c < 0.75);
  const kAt = (t) => { let k = 0; for (const c of cues) { if (c <= t) k += 1; else break; } return k; };
  const clipAt = (t) => kAt(t) % CLIP_LENS.length;
  const slotOf = (ct, len, p) => Math.floor(((((ct + p) % len) + len) % len) / 0.4) % 4;
  const nearBoundary = (ct, len, p) => {
    const x = ((((ct + p) % len) + len) % len) % 0.4;
    return x < 0.09 || x > 0.31;
  };
  const trace = tr.trace || [];

  // per-video wrap events (ct regressed) from the trace
  const wraps = [];
  for (let i = 1; i < trace.length; i += 1) {
    const a = trace[i - 1], b = trace[i];
    for (let v = 0; v < Math.min(a.vs.length, b.vs.length); v += 1) {
      if (a.vs[v][1] - b.vs[v][1] > 1.5) wraps.push({ t: b.t, v, from: a.vs[v][1], to: b.vs[v][1] });
    }
  }
  const readyDrops = [];
  for (const s of trace) {
    for (let v = 0; v < s.vs.length; v += 1) if (s.vs[v][0] < 2) readyDrops.push({ t: s.t, v, rs: s.vs[v][0] });
  }
  const wrapNear = (t, v, w = 0.35) => wraps.some((x) => x.v === v && Math.abs(x.t - t) <= w);

  // --- (1) draw-side validation per clip (ground truth = that clip's ct)
  const drawEvents = [];
  const calib = [];
  for (let i = 0; i < CLIP_LENS.length; i += 1) {
    const samples = trace.filter((s) => s.px && !inFade(s.t) && clipAt(s.t) === i && s.vs.length > i && s.vs[i][0] >= 2);
    let bestP = 0, bestHit = -1;
    for (let p = 0; p < 1.6; p += 0.02) {
      let hit = 0, tot = 0;
      for (const s of samples) {
        if (nearBoundary(s.vs[i][1], CLIP_LENS[i], p) || wrapNear(s.t, i)) continue;
        tot += 1;
        if (classify(s.px) === slotOf(s.vs[i][1], CLIP_LENS[i], p)) hit += 1;
      }
      if (tot && hit / tot > bestHit) { bestHit = hit / (tot || 1); bestP = p; }
    }
    calib.push(+bestP.toFixed(2));
    let ok = 0, bad = 0;
    for (const s of samples) {
      if (nearBoundary(s.vs[i][1], CLIP_LENS[i], bestP) || wrapNear(s.t, i)) continue;
      const L = lum(...s.px);
      if (L < 30) { drawEvents.push({ t: s.t, kind: 'CANVAS-BLACK', v: i }); continue; }
      if (classify(s.px) === slotOf(s.vs[i][1], CLIP_LENS[i], bestP)) ok += 1;
      else { bad += 1; drawEvents.push({ t: s.t, kind: 'CANVAS-STALE', v: i, rgb: s.px, ct: s.vs[i][1] }); }
    }
    console.log(`clip#${i} (len ${CLIP_LENS[i]}s): draw ok=${ok} bad=${bad} p=${bestP.toFixed(2)} (${samples.length} samples)`);
  }

  // --- ct stalls of the DISPLAYED clip (playing but time frozen)
  const stalls = [];
  {
    let runStart = -1, runCt = -1, runClip = -1;
    for (const s of trace) {
      const i = clipAt(s.t);
      if (inFade(s.t) || !s.vs[i] || s.vs[i][0] < 2) { runStart = -1; continue; }
      const ct = s.vs[i][1];
      if (runClip === i && runStart >= 0 && Math.abs(ct - runCt) < 0.005) {
        if (s.t - runStart >= 0.6 && !wrapNear(s.t, i, 1.2)) { stalls.push({ t: s.t, v: i, ct }); runStart = -1; }
      } else { runStart = s.t; runCt = ct; runClip = i; }
    }
  }

  // --- (2) file-side: BLACK + FREEZE + canvas alignment
  const fileEvents = [];
  for (const s of fileScan.scan) {
    if (lum(...s.rgb) < 30) fileEvents.push({ t: s.t, kind: 'BLACK', rgb: s.rgb });
  }
  {
    let runColor = -1, runT = 0;
    for (const s of fileScan.scan) {
      const g = classify(s.rgb);
      if (g === runColor) { if (s.t - runT > 0.9 && lum(...s.rgb) >= 30) { fileEvents.push({ t: s.t, kind: 'FREEZE', rgb: s.rgb }); runT = s.t; } }
      else { runColor = g; runT = s.t; }
    }
  }
  // align file to canvas: t_canvas = t_file + shift
  const canvasAt = (t) => {
    let best = null, bd = 0.25;
    for (const s of trace) { if (!s.px) continue; const d = Math.abs(s.t - t); if (d < bd) { bd = d; best = s; } }
    return best;
  };
  let bestS = 0, bestMatch = -1;
  for (let sh = -0.5; sh <= 2.0; sh += 0.05) {
    let hit = 0, tot = 0;
    for (const s of fileScan.scan) {
      if (inFade(s.t) || lum(...s.rgb) < 30) continue;
      const cs = canvasAt(s.t + sh);
      if (!cs) continue;
      tot += 1;
      if (classify(s.rgb) === classify(cs.px)) hit += 1;
    }
    const m = tot ? hit / tot : 0;
    if (m > bestMatch) { bestMatch = m; bestS = sh; }
  }
  let capBad = 0;
  for (const s of fileScan.scan) {
    if (inFade(s.t) || lum(...s.rgb) < 30) continue;
    const cs = canvasAt(s.t + bestS);
    if (!cs) continue;
    // tolerance: any canvas sample within ±0.25 s matching the file color
    let ok = false;
    for (const s2 of trace) {
      if (s2.px && Math.abs(s2.t - (s.t + bestS)) <= 0.25 && classify(s2.px) === classify(s.rgb)) { ok = true; break; }
    }
    if (!ok) { capBad += 1; fileEvents.push({ t: s.t, kind: 'CAPTURE-MISMATCH', rgb: s.rgb, canvas: cs.px }); }
  }
  console.log(`file↔canvas alignment: shift=${bestS.toFixed(2)}s match=${Math.round(bestMatch * 100)}% mismatches=${capBad}`);

  // merge same-kind file events within 0.25 s
  const mergedAll = [];
  for (const e of [...fileEvents].sort((a, b) => a.t - b.t)) {
    const last = mergedAll[mergedAll.length - 1];
    if (last && last.kind === e.kind && e.t - last.tEnd <= 0.25) { last.tEnd = e.t; continue; }
    mergedAll.push({ ...e, tEnd: e.t });
  }

  const allEvents = [...drawEvents.map((e) => ({ ...e, tEnd: e.t })), ...mergedAll];
  const byKind = {};
  for (const e of allEvents) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  const report = {
    url: APP_URL, file: dl.name, mp4: isMp4, cues, clipLens: CLIP_LENS,
    patternPhase: calib, fileShift: +bestS.toFixed(2),
    fileCanvasMatchPct: Math.round(bestMatch * 100),
    events: allEvents.map((e) => ({ t: +e.t.toFixed(2), tEnd: +(e.tEnd ?? e.t).toFixed(2), kind: e.kind, v: e.v })),
    wraps: wraps.length, readyDrops: readyDrops.length, stalls: stalls.length,
    traceSamples: trace.length,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'flicker_probe.json'), JSON.stringify(report, null, 1));

  console.log(`\nEVENTS: ${JSON.stringify(byKind)}`);
  for (const e of allEvents.slice(0, 50)) {
    console.log(`  ${e.kind.padEnd(16)} t=${e.t.toFixed(2)} v=${e.v ?? '-'}${e.rgb ? ` rgb=${JSON.stringify(e.rgb)}` : ''}`);
  }
  if (stalls.length) console.log(`ct stalls (displayed clip frozen >=0.6 s): ${stalls.slice(0, 10).map((s) => `t${s.t.toFixed(2)}v${s.v}`).join(' ')}`);
  console.log(`live-trace wraps: ${wraps.length}, readyState<2 samples: ${readyDrops.length}`);

  const badTotal = (byKind['CANVAS-STALE'] || 0) + (byKind['CANVAS-BLACK'] || 0)
    + (byKind['BLACK'] || 0) + (byKind['FREEZE'] || 0) + (byKind['CAPTURE-MISMATCH'] || 0);
  await browser.close();
  console.log(`\nprobe done — ${JSON.stringify(byKind)}, file↔canvas match ${report.fileCanvasMatchPct}%`);
  process.exit(badTotal > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
