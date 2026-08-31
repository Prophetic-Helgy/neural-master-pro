/**
 * electron-v25-smoke.cjs — packaged-equivalent smoke for v2.5 (risk B),
 * aligned with the v2.5 HARDENED main.cjs config:
 *   nodeIntegration:false, contextIsolation:true, sandbox:true,
 *   webSecurity:true, preload.cjs contextBridge, dist served over the
 *   privileged app://bundle/ scheme (file:// has an opaque origin, which
 *   blocks the blob: metrics worker — the same scheme the packaged app uses).
 *
 * Proves, with the real production webPreferences + origin:
 *   1. window.nmpIpc exists (preload contextBridge mounted) and an IPC
 *      round-trip resolves through the sandbox boundary;
 *   2. the INLINE metrics worker (base64 blob URL) runs — the production
 *      seam window.__nmp_metrics_mode === 'worker';
 *   3. the React app renders (canvases + body text);
 *   4. (v2.6) the built ASR module worker boots under app:// — bundled
 *      Whisper model loads via the app:// fetch path and a 1 s silence
 *      transcribe completes (ORT wasm under 'wasm-unsafe-eval').
 *
 * The TONE fixture is read in the MAIN process and injected as base64 —
 * the sandboxed renderer has no require('fs') anymore (v2.5 pentest fix).
 *
 * Exits 0 on success, 2 on load fail, 3 on check fail, 4 on timeout.
 *
 * Run:  npx electron scripts/electron-v25-smoke.cjs   (after `npm run build`
 *       and `node scripts/e2e.cjs`-style fixture generation — needs
 *       docs/screenshots/e2e_tone.wav)
 */
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const fs = require('fs');

// Same privileged scheme as main.cjs — the smoke must load the app from the
// same origin class the packaged EXE uses.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const TIMEOUT_MS = 300_000; // includes the ASR step: model load under app:// takes a while
const TONE = path.join(__dirname, '..', 'docs', 'screenshots', 'e2e_tone.wav');
// Real-speech fixture (LibriSpeech flac, dev-time test data, never shipped) —
// optional: without it the ASR smoke falls back to the 1 s silence probe.
const SPEECH = path.join(os.tmpdir(), 'asr_real.flac');
const PRELOAD = path.join(__dirname, '..', 'preload.cjs');
const APP_PKG = require(path.join(__dirname, '..', 'package.json'));

// Same IPC channels as the real main.cjs — stubbed with known answers so the
// smoke can prove the bridge round-trip through the sandbox.
ipcMain.handle('get-hardware-info', () => ({ cpuName: 'SMOKE-CPU', gpuName: 'SMOKE-GPU' }));
ipcMain.handle('get-hardware-temps', () => ({ cpuTemp: null, gpuTemp: null, cpuLoad: null, gpuLoad: null }));

app.whenReady().then(async () => {
  if (!fs.existsSync(TONE)) {
    console.error('SMOKE FAIL: tone fixture missing:', TONE, '(generate fixtures first)');
    app.exit(3);
  }
  const toneB64 = fs.readFileSync(TONE).toString('base64');

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
      preload: PRELOAD,
    },
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

  // 1) contextBridge + sandboxed IPC round-trip.
  const bridge = await win.webContents.executeJavaScript(`(async () => {
    try {
      if (!window.nmpIpc) return { ok: false, err: 'window.nmpIpc missing (preload not mounted)' };
      const info = await window.nmpIpc.getHardwareInfo();
      const nodeLeak = typeof window.require === 'function';
      return { ok: !!info && info.cpuName === 'SMOKE-CPU' && !nodeLeak, info, nodeLeak };
    } catch (e) { return { ok: false, err: String(e) }; }
  })()`);
  console.log('BRIDGE CHECK:', JSON.stringify(bridge));

  // 2) worker smoke: inject the fixture as base64 (no fs in the sandbox) and
  //    wait for the production metrics seam.
  const res = await win.webContents.executeJavaScript(`(async () => {
    try {
      const input = document.querySelector('#track-upload');
      if (!input) return { ok: false, err: '#track-upload not found' };
      // The engine must be READY before the upload path can decode + measure
      // (faust init takes a few seconds under file://).
      const readyDeadline = Date.now() + 120_000;
      let ready = false;
      while (Date.now() < readyDeadline) {
        ready = /FAUST CORE ACTIVE/i.test(document.body.innerText);
        if (ready) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!ready) return { ok: false, err: 'engine never reached READY under file://' };
      window.__smokeErrs = [];
      window.addEventListener('error', (e) => window.__smokeErrs.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__smokeErrs.push('rej: ' + String(e.reason)));
      window.addEventListener('securitypolicyviolation', (e) => window.__smokeErrs.push('csp: ' + e.blockedURI));
      // Environment probe: does a self-contained blob classic worker answer
      // under this origin/sandbox at all (same class as the vite inline worker)?
      window.__blobProbe = await new Promise((resolve) => {
        try {
          const b = new Blob(['self.onmessage = () => postMessage("pong");'], { type: 'text/javascript;charset=utf-8' });
          const u = URL.createObjectURL(b);
          const w = new Worker(u);
          const t = setTimeout(() => resolve('timeout'), 5000);
          w.onmessage = () => { clearTimeout(t); resolve('ok'); };
          w.onerror = (ev) => { clearTimeout(t); resolve('err: ' + ev.message); };
          w.postMessage('ping');
        } catch (e) { resolve('ctor: ' + e.message); }
      });
      const bin = atob(${JSON.stringify(toneB64)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'e2e_tone.wav', { type: 'audio/wav' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      // The metrics seam (window.__nmp_metrics_mode) is set only after the
      // engine has loaded the track, is ready, and the metrics pass finished —
      // 'worker' proves the inline blob worker ran under file:. __NMP__ is
      // DEV-only and absent from production builds, so the seam is the signal.
      const deadline = Date.now() + ${TIMEOUT_MS - 40_000};
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
        blobProbe: window.__blobProbe || null,
        errs: (window.__smokeErrs || []).slice(0, 5),
        fileCount: (document.querySelector('#track-upload') || {}).files ? (document.querySelector('#track-upload').files.length) : -1,
        trackShown: /e2e_tone/i.test(document.body.innerText),
        readyAfter: /FAUST CORE ACTIVE/i.test(document.body.innerText),
        busy: /analyz|loading|please wait/i.test(document.body.innerText),
        canvases: document.querySelectorAll('canvas').length,
        bodyText: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 700),
      };
    } catch (e) {
      return { ok: false, err: String((e && e.stack) || e), protocol: location.protocol };
    }
  })()`);

  clearTimeout(guard);
  // 3) Bundled Whisper model must be served under app:// (proves public/→dist
  //    copy by electron-builder and the app:// fetch path the ASR worker uses).
  const model = await win.webContents.executeJavaScript(`(async () => {
    const files = ['models/whisper-base/config.json', 'models/whisper-base/tokenizer.json',
      'models/whisper-base/onnx/encoder_model_quantized.onnx'];
    const out = {};
    for (const f of files) {
      try {
        const r = await fetch('app://bundle/' + f, { method: 'HEAD' });
        out[f.split('/').pop()] = r.status + ':' + (r.headers.get('content-length') || '?');
      } catch (e) { out[f.split('/').pop()] = 'ERR ' + e.message; }
    }
    return out;
  })()`);
  console.log('MODEL CHECK:', JSON.stringify(model));
  const modelOk = Object.values(model).every((v) => String(v).startsWith('200'));

  // 4) ASR worker end-to-end under app:// (v2.6 top risk): spawn the REAL
  //    built module worker, load the bundled Whisper model through the app://
  //    fetch handler + CSP, and transcribe REAL SPEECH (10 s LibriSpeech
  //    fixture injected as base64, WebGPU→WASM fallback inside). Non-empty
  //    recognized text proves worker module imports, ORT session
  //    instantiation ('wasm-unsafe-eval'), the model stream path AND the
  //    tokenizer/feature-extractor load all work in the packaged origin
  //    class (a metadata-probe regression shows up as null tokenizer → empty
  //    output, which this catches). Without the dev fixture the step falls
  //    back to the 1 s silence boot probe.
  const speechB64 = fs.existsSync(SPEECH) ? fs.readFileSync(SPEECH).toString('base64') : '';
  const assetsDir = path.join(distRoot, 'assets');
  const asrWorkerName = fs.existsSync(assetsDir)
    ? (fs.readdirSync(assetsDir).find((f) => /^asrWorker-[\w-]+\.js$/.test(f)) || '')
    : '';
  let asr = { ok: false, err: asrWorkerName ? 'spawn failed' : 'asrWorker chunk not found in dist/assets' };
  if (asrWorkerName) {
    asr = await win.webContents.executeJavaScript(`(async () => {
      try {
        let samples = new Float32Array(16000), sr = 16000;
        const b64 = ${JSON.stringify(speechB64)};
        if (b64) {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const actx = new AudioContext();
          const buf = await actx.decodeAudioData(bytes.buffer.slice(0));
          samples = new Float32Array(buf.length);
          for (let i = 0; i < buf.length; i++) samples[i] = buf.getChannelData(0)[i];
          sr = buf.sampleRate;
          await actx.close();
        }
        const w = new Worker('app://bundle/assets/${asrWorkerName}', { type: 'module' });
        const phases = [];
        const r = await new Promise((resolve) => {
          const t = setTimeout(() => resolve({ ok: false, err: 'ASR timeout (model load or transcribe)', phases }), 220_000);
          w.onmessage = (e) => {
            const m = e.data || {};
            if (m.type === 'status') phases.push(m.phase);
            else if (m.type === 'done') {
              const segs = m.segments || [];
              const text = segs.map((s) => s.text || '').join(' ').trim();
              const want = b64 ? segs.length > 0 && text.length > 0 : true;
              clearTimeout(t);
              resolve({ ok: want, speech: !!b64, segments: segs.length, sample: text.slice(0, 80), phases });
            } else if (m.type === 'error') { clearTimeout(t); resolve({ ok: false, err: m.message, phases }); }
          };
          w.onerror = (ev) => { clearTimeout(t); resolve({ ok: false, err: 'worker error: ' + (ev.message || 'unknown'), phases }); };
          w.postMessage({ type: 'transcribe', id: 1, samples, sampleRate: sr });
        });
        w.terminate();
        return r;
      } catch (e) { return { ok: false, err: String(e) }; }
    })()`);
  }
  console.log('ASR CHECK:', JSON.stringify(asr));

  console.log('SMOKE RESULT:', JSON.stringify(res, null, 2));
  console.log('APP VERSION CHECK:', APP_PKG.version, 'title fix:', APP_PKG.version !== '2.2');
  app.exit(res && res.ok && bridge && bridge.ok && modelOk && asr.ok ? 0 : 3);
});
