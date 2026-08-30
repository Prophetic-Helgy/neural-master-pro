/**
 * electron-aac-smoke.cjs — spike check: does the @ffmpeg.wasm MODULE WORKER
 * run under the packaged origin (app://bundle/, same privileged scheme as the
 * v2.5 main.cjs) in Electron with the HARDENED webPreferences (sandboxed,
 * isolated, webSecurity on, preload bridge only)?
 *
 * The aacEncoder chunk name is discovered in the MAIN process (the sandboxed
 * renderer has no fs/path) and passed into the page as a plain string; the
 * page then dynamic-imports it relative to app://bundle/index.html and
 * encodes a 2 s tone to m4a. Exits 0 on success.
 *
 * Run:  npx electron scripts/electron-aac-smoke.cjs   (after `npm run build`)
 */
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

const TIMEOUT_MS = 90_000;
const ASSETS = path.join(__dirname, '..', 'dist', 'assets');

// Same privileged scheme as main.cjs (packaged origin class).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

ipcMain.handle('get-hardware-info', () => null);
ipcMain.handle('get-hardware-temps', () => null);

app.whenReady().then(async () => {
  const chunk = fs.existsSync(ASSETS)
    ? fs.readdirSync(ASSETS).find((f) => f.startsWith('aacEncoder-'))
    : null;
  if (!chunk) {
    console.error('SMOKE FAIL: aacEncoder chunk not found in', ASSETS, '(run `npm run build` first)');
    app.exit(3);
  }

  // Mirror main.cjs: serve dist/ over app://bundle/ (traversal-clamped).
  const distRoot = path.normalize(path.join(__dirname, '..', 'dist'));
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname || '/');
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(distRoot, rel));
    if (filePath !== distRoot && !filePath.startsWith(distRoot + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, '..', 'preload.cjs'),
    },
  });

  const guard = setTimeout(() => {
    console.error('SMOKE TIMEOUT after', TIMEOUT_MS, 'ms');
    app.exit(4);
  }, TIMEOUT_MS);

  try {
    await win.loadURL('app://bundle/index.html');
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
      const t0 = Date.now();
      const mod = await import('./assets/' + ${JSON.stringify(chunk)});
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
  app.exit(res && res.ok && res.ftyp === 'ftyp' ? 0 : 3);
});
