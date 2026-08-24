/**
 * electron-aac-smoke.cjs — spike check: does the @ffmpeg.wasm MODULE WORKER
 * run under file:// in Electron (packaged-equivalent load)?
 *
 * Loads dist/index.html exactly like the packaged app (loadFile,
 * nodeIntegration, webSecurity:false), then imports the built aacEncoder
 * chunk and encodes a 2 s tone to m4a. Exits 0 on success.
 *
 * Run:  npx electron scripts/electron-aac-smoke.cjs   (after `npm run build`)
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

const TIMEOUT_MS = 90_000;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false },
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
      const path = require('path');
      const assetsDir = path.join(__dirname, 'assets');
      const chunk = fs.readdirSync(assetsDir).find((f) => f.startsWith('aacEncoder-'));
      if (!chunk) return { ok: false, err: 'aacEncoder chunk not found in ' + assetsDir };

      const t0 = Date.now();
      const mod = await import('./assets/' + chunk);
      const sr = 44100;
      const off = new OfflineAudioContext(2, sr * 2, sr);
      const osc = off.createOscillator(); osc.frequency.value = 440;
      const g = off.createGain(); g.gain.value = 0.5;
      osc.connect(g).connect(off.destination); osc.start(0);
      const buf = await off.startRendering();
      const res = await mod.encodeAac(buf.getChannelData(0), buf.getChannelData(1), sr, 256,
        { title: 'Smoke', artist: 'NMP' });
      const u8 = new Uint8Array(await res.blob.arrayBuffer());
      const ftyp = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
      return {
        ok: true,
        ms: Date.now() - t0,
        bytes: res.bytes,
        ext: res.ext,
        ftyp,
        protocol: location.protocol,
      };
    } catch (e) {
      return { ok: false, err: String((e && e.stack) || e), protocol: location.protocol };
    }
  })()`);

  clearTimeout(guard);
  console.log('SMOKE RESULT:', JSON.stringify(res, null, 2));
  app.exit(res && res.ok ? 0 : 3);
});
