/** Debug: why does the Lite MASTER run not finish? */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const APP_URL = 'http://localhost:5210/';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const TONE = path.join(OUT_DIR, 'tone_test.wav');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().slice(0, 300)); });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 90000 });
  await new Promise((r) => setTimeout(r, 3000));
  const fi = await page.$('input[type="file"]');
  await fi.uploadFile(TONE);
  await sleep(20000); // generous engine init

  const ready = await page.evaluate(() => /PROCESSING:\s*READY/i.test(document.body.innerText));
  console.log('engine ready:', ready);

  const mode = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'LITE');
    if (b) b.click();
    return !!b;
  });
  await sleep(1500);
  console.log('switched to lite:', mode);

  const clicked = await page.evaluate(() => {
    // Scope to the Lite panel — the transport has a stem-monitor button also
    // labeled "MASTER" which appears earlier in document order.
    // The smallest such div is just the heading (no button) — walk up until
    // the button is found.
    const panels = [...document.querySelectorAll('div')]
      .filter((d) => /LITE MASTER/i.test(d.innerText))
      .sort((a, b) => a.innerText.length - b.innerText.length);
    for (const panel of panels) {
      const b = [...panel.querySelectorAll('button')].find((x) => x.innerText.trim().toUpperCase() === 'MASTER' && !x.disabled);
      if (b) { b.click(); return true; }
    }
    return false;
  });
  console.log('master clicked:', clicked);
  await sleep(20000);

  const dump = await page.evaluate(() => {
    // Find the Lite master panel (contains "LITE MASTER" heading)
    const all = [...document.querySelectorAll('div')];
    const panel = all.find((d) => /LITE MASTER/i.test(d.innerText) && d.innerText.length < 6000);
    const toast = document.querySelector('[class*="toast" i]');
    return {
      panel: panel ? panel.innerText.slice(0, 1500) : 'NO PANEL',
      toast: toast ? toast.innerText : null,
      bodyHasMastered: /MASTERED/i.test(document.body.innerText),
    };
  });
  console.log('--- panel ---');
  console.log(dump.panel);
  console.log('toast:', dump.toast);
  console.log('bodyHasMastered:', dump.bodyHasMastered);
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
