/**
 * e2e-flicker-regress.cjs — M4.5b: Pexels export frame fidelity (flicker
 * regression), shared between scripts/e2e.cjs and a standalone harness
 * (scripts/e2e-m45b-run.cjs) for fast iteration.
 *
 * Four synthetic H.264 clips painted with a 4-color palette cycling every
 * 0.4 s (lengths 2.4/3.2/4.8/6.4 s — loop wraps land at different phases
 * against the cues). Ground truth WITHOUT any wall-clock model: each clip's
 * OWN currentTime says which palette slot must be on screen. The exported
 * file is additionally checked for black frames, freezes (>0.9 s identical)
 * and faithfulness to the live canvas (timeline shift-correlation). The file
 * is read by PLAYING it through (seeking a streamed fMP4 inside the busy app
 * page yields false blacks). Starved decoders / wrap staleness show up as
 * CANVAS-STALE / BLACK / FREEZE / CAPTURE-MISMATCH.
 * Full diagnostics: scripts/e2e-flicker.cjs.
 */

const CLIP_LENS = [2.4, 3.2, 4.8, 6.4];
const PALETTE = [[235, 40, 50], [235, 235, 235], [60, 90, 240], [40, 210, 110]];

const lumF = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const classify = (rgb) => {
  let best = 0, bd = Infinity;
  for (let i = 0; i < 4; i += 1) {
    const d = (PALETTE[i][0] - rgb[0]) ** 2 + (PALETTE[i][1] - rgb[1]) ** 2 + (PALETTE[i][2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};

/**
 * ctx: { page, check, sleep, h, awaitDownload, newPage?, saveFile? }
 * newPage: async () => fresh puppeteer page — when given, the exported file
 * is scanned THERE (a clean page with no other media elements/decoders);
 * scanning inside the busy app page can report FALSE blacks. saveFile(name,
 * buf) dumps the downloaded file to disk for offline inspection.
 * Assumes: track uploaded + engine ready + export modal open (END/format are
 * set here). Leaves the modal in the same state it found it (cleanup runs).
 */
async function runFlickerRegress(ctx) {
  const { page, check, sleep, h, awaitDownload } = ctx;

  // arm export UI first (checkbox -> radios exist), then record clips
  await page.evaluate(() => {
    const cb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => c.parentElement.textContent.includes('Export Video'));
    if (cb && !cb.checked) cb.click();
  });
  await sleep(300);
  const clips = await page.evaluate(async (lens) => {
    const pickMime = () => (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')
      ? 'video/mp4;codecs=avc1' : 'video/webm');
    const PAL = [[235, 40, 50], [235, 235, 235], [60, 90, 240], [40, 210, 110]];
    const recOnce = (lenSec, mime) => new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 360;
      const cx = c.getContext('2d');
      const t0 = performance.now();
      const paint = () => {
        const el = performance.now() - t0;
        const idx = Math.floor((el % 1600) / 400) % 4;
        cx.fillStyle = `rgb(${PAL[idx][0]},${PAL[idx][1]},${PAL[idx][2]})`;
        cx.fillRect(0, 0, 640, 360);
      };
      paint();
      const stream = c.captureStream(30);
      const iv = setInterval(paint, 60);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_000_000 });
      const chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = () => {
        clearInterval(iv);
        stream.getTracks().forEach((tr) => tr.stop());
        resolve({ url: URL.createObjectURL(new Blob(chunks, { type: mime })), bytes: chunks.reduce((s, x) => s + x.size, 0) });
      };
      rec.start(500);
      setTimeout(() => { try { rec.stop(); } catch { /* resolved via stop event */ } }, Math.round(lenSec * 1000));
    });
    for (let w = 0; w < 2; w += 1) await recOnce(0.3, pickMime()); // warm the recorder
    const out = [];
    for (const len of lens) {
      let got = null;
      for (let t = 0; t < 4 && (!got || got.bytes < 2000); t += 1) got = await recOnce(len, pickMime());
      out.push(got);
    }
    return out;
  }, CLIP_LENS);
  check('flicker-regress: 4 pattern clips recorded', clips.length === 4 && clips.every((c) => c.bytes > 2000),
    clips.map((c) => c.bytes).join(','));

  const selOk = await page.evaluate((urls) => {
    const ok = window.__NMP__.setPexelsTestSelection(urls.map((u, i) => ({ url: u, author: `A${i}` })));
    const radios = [...document.querySelectorAll('input[type="radio"][name="videoBgMode"]')];
    if (radios[1] && !radios[1].checked) radios[1].click();
    return ok === true && radios.length >= 2;
  }, clips.map((c) => c.url));
  await page.evaluate(() => {
    // LAST END label wins: the export modal renders after earlier panels, and
    // a full-suite run may leave other 'END' inputs (region tools) in the DOM
    // — the first match would set the wrong field (cues vanish, region <=3 s).
    const labs = [...document.querySelectorAll('label')].filter((l) => l.textContent.trim().toUpperCase().startsWith('END'));
    const inp = labs[labs.length - 1].parentElement.querySelector('input[type="number"]');
    window.__h.inputSet(inp, 10);
    const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'wav'));
    window.__h.inputSet(sel, 'wav');
    // Pin the cue list (dev seam): this block tests frame fidelity, not peak
    // detection (M4.5 covers that). A full-suite run can leave the mastering
    // chain in a state where the rendered master has no detectable peaks, and
    // the whole block would cascade-fail on cues=0.
    try { window.__NMP__.setPexelsTestCues([2.5, 5, 7.5]); } catch { /* dev-only */ }
    const cb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => c.parentElement.textContent.includes('Export Video'));
    if (cb && !cb.checked) cb.click();
  });
  await sleep(300);
  check('flicker-regress: 4-clip selection armed (Pexels mode, 10 s, wav)', selOk, `selOk=${selOk}`);

  // live trace (draw side): canvas mean color + per-video ct/readyState/paused
  const tracePromise = page.evaluate(async () => {
    const trace = [];
    const findCanvas = () => [...document.querySelectorAll('canvas')]
      .find((c) => { let el = c.parentElement; while (el) { if (el.style && el.style.top === '-9999px') return true; el = el.parentElement; } return false; });
    const off = document.createElement('canvas'); off.width = 24; off.height = 14;
    const ox = off.getContext('2d', { willReadFrequently: true });
    const e = window.__NMP__.getEngine();
    const t0 = Date.now();
    let vids = [];
    while (Date.now() - t0 < 30000) {
      try { vids = window.__NMP__.getBgVideos(); } catch { vids = []; }
      if (vids.length === 4 && vids.every((v) => v.readyState >= 2)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (vids.length !== 4) return { error: `bg videos not ready (${vids.length})`, trace };
    const deadline = Date.now() + 90000;
    let lastT = -1, idleSince = Date.now();
    while (Date.now() < deadline) {
      const t = e.getCurrentTime();
      if (t > 9.9 || (t > 0.5 && Math.abs(t - lastT) < 0.001 && Date.now() - idleSince > 4000)) break;
      if (Math.abs(t - lastT) >= 0.001) { lastT = t; idleSince = Date.now(); }
      const cv = findCanvas();
      let px = null;
      if (cv) {
        // top-left 45%: cover frame/title/credit only occupy bottom half / bottom-right
        ox.drawImage(cv, 0, 0, Math.floor(cv.width * 0.45), Math.floor(cv.height * 0.45), 0, 0, 24, 14);
        const d = ox.getImageData(0, 0, 24, 14).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        px = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      }
      trace.push({ t: +t.toFixed(3), px, vs: vids.map((v) => [v.readyState, +(v.currentTime || 0).toFixed(3), v.paused ? 1 : 0]) });
      await new Promise((r) => setTimeout(r, 80));
    }
    return { trace };
  });

  const dbgBefore = await page.evaluate(() => (window.__NMP__.getPexelsDebug ? window.__NMP__.getPexelsDebug() : null));
  // Drain the download hook queue BEFORE clicking: earlier sections stack
  // audio/video/srt downloads, and a stale mp4 from the previous export would
  // be scanned in place of ours (full-suite runs caught M4.5's file this way
  // — black/freeze/mismatch of a file we never exported).
  for (let stale = await awaitDownload(page, 1200); stale; stale = await awaitDownload(page, 1200)) {
    const isVid = stale.buf.length > 8
      && (stale.buf.readUInt32BE(0) === 0x1a45dfa3 || stale.buf.toString('ascii', 4, 8) === 'ftyp');
    if (isVid && ctx.saveFile) {
      try { ctx.saveFile('drained_m45a_' + (stale.name || 'clip.mp4'), stale.buf); } catch { /* diagnostic only */ }
    }
    console.log(`    [flicker-regress] drained stale download: ${stale.name || '?'} (${stale.buf.length} B)${isVid ? ' [video -> dump]' : ''}`);
  }
  const expClicked = await h(page, 'clickText', 'Export');
  // The export downloads audio first, video second — take until a video
  // container lands (EBML webm magic or ftyp@4 for mp4).
  let dl = null;
  const dlDeadline = Date.now() + 180000;
  while (!dl && Date.now() < dlDeadline) {
    const d = await awaitDownload(page, 20000);
    if (!d) continue;
    const isVid = d.buf.length > 8
      && (d.buf.readUInt32BE(0) === 0x1a45dfa3 || d.buf.toString('ascii', 4, 8) === 'ftyp');
    if (isVid) dl = d;
  }
  const tr = await tracePromise;
  const cues = await page.evaluate(() => (window.__NMP__.getExportBgCues() || []).map((x) => +x.toFixed(3)));
  const dbgAfter = await page.evaluate(() => (window.__NMP__.getPexelsDebug ? window.__NMP__.getPexelsDebug() : null));
  check('flicker-regress: export ran (click + download + >=2 cues)', !!dl && expClicked && cues.length >= 2,
    `${dl ? dl.name : 'no download'} cues=[${cues}] traceErr=${tr.error || '-'} clicked=${expClicked} dbg=${JSON.stringify(dbgBefore)} dbgA=${JSON.stringify(dbgAfter)}`);
  // Decoder budget: the bg clips kept looping after the export; while the
  // scan element plays the exported file back they compete for Chrome's
  // media decoders and the scan reads false blacks. Pause them — the trace
  // is done, they are not needed anymore.
  await page.evaluate(() => {
    try { window.__NMP__.getBgVideos().forEach((v) => v.pause()); } catch { /* dev-only */ }
  });

  let fileOk = false, black = -1, freeze = -1, capMismatch = -1, canvasStale = -1, canvasBlack = -1;
  let maxPlaying = 0;
  if (dl && !tr.error && cues.length >= 2) {
    const isMp4 = dl.buf.length > 8 && dl.buf.toString('ascii', 4, 8) === 'ftyp';
    const b64 = dl.buf.toString('base64');
    if (ctx.saveFile) { try { ctx.saveFile(dl.name || 'flicker_export.mp4', dl.buf); } catch { /* diagnostic only */ } }
    // Play the file through (no seeking — a streamed fMP4 seeks unreliably in
    // a busy page and reports false blacks), sample the same top-left 45%.
    // With ctx.newPage the scan runs in a FRESH page: zero competing decoders.
    const scanPage = ctx.newPage ? await ctx.newPage() : page;
    const scan = await (async () => {
      try { return await scanPage.evaluate(async (b64s, mime) => {
      const bin = atob(b64s);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([u8], { type: mime }));
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = url;
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('decode fail')); });
      const dur = Number.isFinite(v.duration) && v.duration > 0.5 ? v.duration : 10.2;
      const off = document.createElement('canvas'); off.width = 24; off.height = 14;
      const ox = off.getContext('2d', { willReadFrequently: true });
      const out = [];
      let nextT = 0;
      const wall = Date.now() + 60000;
      try { await v.play(); } catch { /* autoplay policy */ }
      while (nextT < dur && Date.now() < wall) {
        // setTimeout, not rAF: a background/hidden page freezes rAF entirely.
        await new Promise((r) => setTimeout(r, 16));
        if (v.currentTime < nextT) continue;
        ox.drawImage(v, 0, 0, Math.floor(v.videoWidth * 0.45), Math.floor(v.videoHeight * 0.45), 0, 0, 24, 14);
        const d = ox.getImageData(0, 0, 24, 14).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        out.push({ t: +v.currentTime.toFixed(2), rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)] });
        nextT += 0.12;
      }
      v.pause();
      URL.revokeObjectURL(url);
      v.removeAttribute('src'); v.load();
      return out;
      }, b64, isMp4 ? 'video/mp4;codecs=avc1' : 'video/webm');
      } finally {
        if (scanPage !== page) {
          await scanPage.close().catch(() => {});
          // restore focus/rAF to the app page for the sections that follow
          await page.bringToFront().catch(() => {});
        }
      }
    })();

    const inFade = (t) => cues.some((c) => t - c >= -0.1 && t - c < 0.75);
    const kAt = (t) => { let k = 0; for (const c of cues) { if (c <= t) k += 1; else break; } return k; };
    const clipAt = (t) => kAt(t) % 4;
    const slotOf = (ct, len, p) => Math.floor(((((ct + p) % len) + len) % len) / 0.4) % 4;
    const nearB = (ct, len, p) => { const x = ((((ct + p) % len) + len) % len) % 0.4; return x < 0.09 || x > 0.31; };
    const wraps = [];
    for (let i = 1; i < tr.trace.length; i += 1) {
      const a = tr.trace[i - 1], b = tr.trace[i];
      for (let v = 0; v < Math.min(a.vs.length, b.vs.length); v += 1) {
        if (a.vs[v][1] - b.vs[v][1] > 1.5) wraps.push({ t: b.t, v });
      }
    }
    const wrapNear = (t, v) => wraps.some((x) => x.v === v && Math.abs(x.t - t) <= 0.35);
    // Decoder budget concerns the CAPTURE window. Before the export click the
    // four clips play freely (warm-up by design) and the engine clock is a
    // frozen pre-export position (any value from the previous section) — those
    // samples are not part of the export. Count only after the engine clock
    // started advancing (export running) and past its first half-second (the
    // draw loop pauses non-active clips within its first frames).
    let moving = false, prevT = -1;
    for (const s of tr.trace) {
      if (!moving && s.t > prevT + 0.0005) moving = true;
      prevT = s.t;
      if (!moving || s.t < 0.5) continue;
      const playing = s.vs.filter((x) => !x[2]).length;
      if (playing > maxPlaying) maxPlaying = playing;
    }
    // draw-side check per clip (ground truth = clip's own ct)
    canvasStale = 0; canvasBlack = 0;
    for (let i = 0; i < 4; i += 1) {
      const samples = tr.trace.filter((s) => s.px && !inFade(s.t) && clipAt(s.t) === i && s.vs[i] && s.vs[i][0] >= 2 && !wrapNear(s.t, i));
      let bestP = 0, bestHit = -1;
      for (let p = 0; p < 1.6; p += 0.04) {
        let hit = 0, tot = 0;
        for (const s of samples) {
          if (nearB(s.vs[i][1], CLIP_LENS[i], p)) continue;
          tot += 1;
          if (classify(s.px) === slotOf(s.vs[i][1], CLIP_LENS[i], p)) hit += 1;
        }
        if (tot && hit / tot > bestHit) { bestHit = hit / (tot || 1); bestP = p; }
      }
      for (const s of samples) {
        if (nearB(s.vs[i][1], CLIP_LENS[i], bestP)) continue;
        if (lumF(...s.px) < 30) { if (s.t >= 0.35) canvasBlack += 1; }
        else if (classify(s.px) !== slotOf(s.vs[i][1], CLIP_LENS[i], bestP)) canvasStale += 1;
      }
    }
    // file-side: black / freeze / canvas faithfulness
    black = 0; freeze = 0;
    let runColor = -1, runT = 0;
    for (const s of scan) {
      if (lumF(...s.rgb) < 30) {
        // t<0.35: canvas/recorder cold-start (first frame before the first draw)
        if (s.t >= 0.35) black += 1;
        continue;
      }
      const g = classify(s.rgb);
      if (g === runColor) { if (s.t - runT > 0.9) { freeze += 1; runT = s.t; } }
      else { runColor = g; runT = s.t; }
    }
    const canvasAt = (t) => {
      let best = null, bd = 0.3;
      for (const s of tr.trace) { if (!s.px) continue; const d = Math.abs(s.t - t); if (d < bd) { bd = d; best = s; } }
      return best;
    };
    let bestS = 0, bestM = -1;
    for (let sh = -0.5; sh <= 2.0; sh += 0.1) {
      let hit = 0, tot = 0;
      for (const s of scan) {
        if (inFade(s.t) || lumF(...s.rgb) < 30) continue;
        const cs = canvasAt(s.t + sh);
        if (!cs) continue;
        tot += 1;
        if (classify(s.rgb) === classify(cs.px)) hit += 1;
      }
      if (tot && hit / tot > bestM) { bestM = hit / tot; bestS = sh; }
    }
    capMismatch = 0;
    for (const s of scan) {
      if (inFade(s.t) || lumF(...s.rgb) < 30) continue;
      if (!canvasAt(s.t + bestS)) continue;
      let ok = false;
      for (const s2 of tr.trace) {
        if (s2.px && Math.abs(s2.t - (s.t + bestS)) <= 0.3 && classify(s2.px) === classify(s.rgb)) { ok = true; break; }
      }
      if (!ok) capMismatch += 1;
    }
    fileOk = true;
    console.log(`    [flicker-regress] file scan n=${scan.length} shift=${bestS.toFixed(2)} stale=${canvasStale} mismatch=${capMismatch}`);
  }

  check('flicker-regress: no black frames in the exported file', fileOk && black === 0, `black=${black}`);
  check('flicker-regress: no frozen frames (>=0.9 s identical)', fileOk && freeze === 0, `freeze=${freeze}`);
  check('flicker-regress: drawn frames match the clip clock (stale<=2, black=0)',
    fileOk && canvasStale <= 2 && canvasBlack === 0, `stale=${canvasStale} black=${canvasBlack}`);
  check('flicker-regress: file faithful to canvas (mismatch<=3)', fileOk && capMismatch <= 3, `mismatch=${capMismatch}`);
  check('flicker-regress: decoder budget — at most 3 clips playing at once', fileOk && maxPlaying <= 3, `maxPlaying=${maxPlaying}`);

  // cleanup: back to the visualizer background, selection cleared
  await page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[type="radio"][name="videoBgMode"]')];
    if (radios[0] && !radios[0].checked) radios[0].click();
    const cb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => c.parentElement.textContent.includes('Export Video'));
    if (cb && cb.checked) cb.click();
    try { window.__NMP__.setPexelsTestSelection([]); } catch { /* dev-only */ }
    try { window.__NMP__.setPexelsTestCues(null); } catch { /* dev-only */ }
  });
  await sleep(300);
}

module.exports = { runFlickerRegress };
