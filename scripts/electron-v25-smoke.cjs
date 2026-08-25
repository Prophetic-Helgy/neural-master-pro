/**
 * electron-v25-smoke.cjs — packaged-equivalent smoke for v2.5 (risk B):
 * does the INLINE metrics worker (base64 blob URL) actually run under file://
 * in a production build?
 *
 * Loads dist/index.html exactly like the packaged app (loadFile,
 * nodeIntegration, webSecurity:false), uploads the TONE fixture through the
 * real #track-upload input (DataTransfer + change event) and waits for the
 * engine to report the metrics path via window.__nmp_metrics_mode
 * (unconditional diagnostic seam in AudioEngine — the DEV-only __NMP__ hook
 * is stripped from production builds).
 *
 * Exits 0 on success, 2 on load fail, 3 on check fail, 4 on timeout.
 *
 * Run:  npx electron scripts/electron-v25-smoke.cjs   (after `npm run build`)
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const TIMEOUT_MS = 180_000;
const TONE = path.join(__dirname, '..', 'docs', 'screenshots', 'e2e_tone.wav');

// The packaged main process registers these; stub them so the renderer's
// hardware-info pings don't reject in the smoke harness.
ipcMain.handle('get-hardware-info', () => null);
ipcMain.handle('get-hardware-temps', () => null);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false },
  });

  // Forward page console for diagnosis (level 3 = error).
  win.webContents.on('console-message', (event, level, message) => {
    try {
      console.log(`[page ${level === 3 ? 'ERR' : 'log'}] ${message}`.slice(0, 300));
    } catch { /* newer Electron passes an event object */ }
  });

  const guard = setTimeout(() => {
    console.error('SMOKE TIMEOUT after', TIMEOUT_MS, 'ms');
    app.exit(4);
  }, TIMEOUT_MS);

  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } catch (e) {
    console.error('SMOKE LOAD FAIL:', e && e.message);
    app.exit(2);
  }

  // Wait for the React app to mount (any <select> appears).
  for (let i = 0; i < 60; i++) {
    try {
      if (await win.webContents.executeJavaScript('!!document.querySelector("select")')) break;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  const res = await win.webContents.executeJavaScript(`(async () => {
    try {
      const fs = require('fs');
      const tonePath = ${JSON.stringify(TONE)};
      if (!fs.existsSync(tonePath)) return { ok: false, err: 'tone fixture missing: ' + tonePath };

      const input = document.querySelector('#track-upload');
      if (!input) return { ok: false, err: '#track-upload not found' };
      const buf = fs.readFileSync(tonePath);
      const file = new File([buf], 'e2e_tone.wav', { type: 'audio/wav' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      // The metrics seam (window.__nmp_metrics_mode) is set only after the
      // engine has loaded the track, is ready, and the metrics pass finished —
      // 'worker' proves the inline blob worker ran under file:. __NMP__ is
      // DEV-only and absent from production builds, so the seam is the signal.
      const deadline = Date.now() + ${TIMEOUT_MS - 30_000};
      let mode = null;
      while (Date.now() < deadline) {
        mode = window.__nmp_metrics_mode || null;
        if (mode) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return {
        ok: mode === 'worker',
        protocol: location.protocol,
        metricsMode: mode,
        hasMediaRecorder: typeof MediaRecorder !== 'undefined',
        hasCanvasCaptureStream: !!(HTMLCanvasElement.prototype && HTMLCanvasElement.prototype.captureStream),
        canvases: document.querySelectorAll('canvas').length,
        bodyText: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 700),
      };
    } catch (e) {
      return { ok: false, err: String((e && e.stack) || e), protocol: location.protocol };
    }
  })()`);

  clearTimeout(guard);
  console.log('SMOKE RESULT:', JSON.stringify(res, null, 2));
  app.exit(res && res.ok ? 0 : 3);
});
