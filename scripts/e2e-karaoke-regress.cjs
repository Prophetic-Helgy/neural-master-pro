/**
 * e2e-karaoke-regress.cjs — M1.14 karaoke burn-in regression block (shared by
 * scripts/e2e.cjs and scripts/e2e-karaoke-run.cjs). Requires a loaded track
 * (the 10 s TONE fixture) and the DEV seam __NMP__.setKaraokeTestLines.
 *
 * Checks: (1) export gate — karaoke checkbox without lines disables Export,
 * seam-injected lines re-enable it; (2) export downloads an .srt with the
 * injected lines and their timings; (3) the export canvas' bottom overlay band
 * shows white-grayish text pixels ONLY inside the active line windows.
 */
async function runKaraokeRegress({ page, check, sleep, h, awaitDownload }) {
  // Region [0,6] on the 10 s TONE track; test lines active 1.5–3.0 and
  // 3.5–5.5 (seconds from region start — same clock as karaokeGetTime).
  await page.evaluate(() => {
    const lab = [...document.querySelectorAll('label')].find((l) => l.textContent.trim().toUpperCase().startsWith('END'));
    const inp = lab.parentElement.querySelector('input[type="number"]');
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    proto.call(inp, '6'); inp.dispatchEvent(new Event('input', { bubbles: true }));
    const cb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => c.parentElement.textContent.includes('Export Video'));
    if (cb && !cb.checked) cb.click();
  });
  await sleep(300);
  // Gate: karaoke checkbox WITHOUT lines must disable Export; lines re-enable.
  const gate = await page.evaluate(() => {
    const kcb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => /karaoke subtitles/i.test(c.parentElement.textContent));
    if (!kcb) return { found: false };
    if (!kcb.checked) kcb.click();
    return { found: true };
  });
  await sleep(250);
  const btnDisabledNoLines = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Export');
    return b ? b.disabled : null;
  });
  const seamOk = await page.evaluate(() => window.__NMP__.setKaraokeTestLines([
    { start: 1.5, end: 3.0, text: 'KARAOKE DEMO LINE ONE' },
    { start: 3.5, end: 5.5, text: 'SECOND KARAOKE LINE' },
  ]));
  await sleep(250);
  const btnEnabledLines = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Export');
    return b ? b.disabled : null;
  });
  check('karaoke: gate — lines required (disabled without, enabled with)',
    gate.found && btnDisabledNoLines === true && seamOk === true && btnEnabledLines === false,
    `found=${gate.found} noLines=${btnDisabledNoLines} withLines=${btnEnabledLines}`);

  // Sample the bottom overlay band of the export canvas during the export:
  // white-grayish text pixels (the neon #00ffd2 art is excluded on purpose).
  const pollPromise = page.evaluate(async () => {
    const findCanvas = () => [...document.querySelectorAll('canvas')]
      .find((c) => { let el = c.parentElement; while (el) { if (el.style && el.style.top === '-9999px') return true; el = el.parentElement; } return false; });
    const samples = [];
    const e = window.__NMP__.getEngine();
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      const t = e.getCurrentTime();
      const cv = findCanvas();
      if (cv && t > 0.3 && t < 6.2) {
        const fs = Math.max(cv.height * 0.026, 26);
        const margin = Math.max(cv.height * 0.05, 44);
        const x0 = Math.floor(cv.width * 0.05), x1 = Math.ceil(cv.width * 0.95);
        const y0 = Math.floor(cv.height - margin - fs * 1.6), y1 = Math.ceil(cv.height - margin * 0.5);
        const off = document.createElement('canvas');
        off.width = x1 - x0; off.height = Math.max(1, y1 - y0);
        const ox = off.getContext('2d', { willReadFrequently: true });
        ox.drawImage(cv, x0, y0, x1 - x0, y1 - y0, 0, 0, off.width, off.height);
        const d = ox.getImageData(0, 0, off.width, off.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (Math.min(r, g, b) > 130 && Math.max(r, g, b) - Math.min(r, g, b) < 60) n += 1;
        }
        samples.push({ t: +t.toFixed(3), n });
      }
      if (t > 6.2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return samples;
  });
  const expOk = await h(page, 'clickText', 'Export');
  // Downloads arrive audio → video → SRT; take everything until the .srt.
  let srt = null, sawVideo = false;
  const dlDeadline = Date.now() + 180000;
  while (!srt && Date.now() < dlDeadline) {
    const d = await awaitDownload(page, 20000);
    if (!d) continue;
    if (d.name && d.name.endsWith('.srt')) srt = d;
    else if (d.buf.length > 8 && (d.buf.readUInt32BE(0) === 0x1a45dfa3 || d.buf.toString('ascii', 4, 8) === 'ftyp')) sawVideo = true;
  }
  const samples = await pollPromise;
  const srtText = srt ? srt.buf.toString('utf8') : '';
  check('karaoke: export ran + .srt downloaded with lines + timings',
    expOk && !!srt && /KARAOKE DEMO LINE ONE/.test(srtText) && /SECOND KARAOKE LINE/.test(srtText)
    && /00:00:01,500 --> 00:00:03,000/.test(srtText),
    `${srt ? srt.name : 'no srt'} video=${sawVideo}`);

  const act = samples.filter((s) => (s.t >= 1.6 && s.t <= 2.9) || (s.t >= 3.6 && s.t <= 5.4));
  const inact = samples.filter((s) => (s.t >= 0.4 && s.t <= 1.35) || (s.t >= 3.05 && s.t <= 3.45));
  const minAct = act.length ? Math.min(...act.map((s) => s.n)) : -1;
  const maxInact = inact.length ? Math.max(...inact.map((s) => s.n)) : -1;
  check('karaoke: burn-in pixels during active lines (min >= 40)', act.length >= 3 && minAct >= 40,
    `samples=${samples.length} act=${act.length} min=${minAct}`);
  // Background art in some visualizer modes (flight stars) has white pixels
  // in the band — a constant burn-in bug would make inactive ≈ active, so
  // the ceiling is relative to the active-line signal instead of absolute.
  check('karaoke: no burn-in pixels outside active windows (<20% of active)',
    inact.length >= 2 && maxInact <= Math.max(15, minAct * 0.2),
    `inact=${inact.length} max=${maxInact} minAct=${minAct}`);

  await page.evaluate(() => {
    try { window.__NMP__.setKaraokeTestLines(null); } catch { /* dev-only */ }
    const cb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((c) => c.parentElement.textContent.includes('Export Video'));
    if (cb && cb.checked) cb.click();
  });
  await sleep(300);
}

module.exports = { runKaraokeRegress };
