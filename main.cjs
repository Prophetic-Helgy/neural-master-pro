const { app, BrowserWindow, ipcMain, session, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const pkg = require('./package.json');

// Packaged builds serve dist/ over the privileged standard scheme `app://bundle/`
// instead of loadFile(). A file:// page lives in an OPAQUE origin, and Chromium
// then refuses blob: workers (metrics / vocal-align inline workers) and several
// same-origin fetches (wasm) from it. A registered standard scheme gives the
// renderer a real origin (app://bundle) while webSecurity + sandbox stay ON.
// Must be registered before app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Set AppUserModelID for proper taskbar icon on Windows 7+
if (process.platform === 'win32') {
  app.setAppUserModelId(app.getName() || 'com.neuralmasterpro.app');
}

// Single instance: a second launch focuses the first window instead of
// spawning another renderer (and another TempServer process).
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    // Version tracked from package.json — no stale hardcoded title.
    title: `Neural Master Pro ${pkg.version}`,
    icon: path.join(__dirname, 'public', 'logo.ico'),
    frame: false,
    webPreferences: {
      // Security baseline (v2.5 pentest): the renderer gets NO Node access —
      // only the narrow contextBridge in preload.cjs. webSecurity stays on:
      // the app is file:// + blob: + wasm, all same-origin compatible.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  win.setMenuBarVisibility(false);
  // Keep the versioned window title; the page's <title> must not override it.
  win.on('page-title-updated', (e) => e.preventDefault());

  // Navigation guards: the app never navigates anywhere on its own. Packaged
  // runs on file://, dev on the vite origin — anything else is denied.
  win.webContents.on('will-navigate', (event, url) => {
    const isDevServer = !app.isPackaged && url.startsWith('http://localhost:3000');
    if (url.startsWith('app://') || url.startsWith('file://') || isDevServer) return;
    event.preventDefault();
  });
  // No popups, ever (the UI opens no windows; window.open is attack surface).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (app.isPackaged) {
    win.loadURL('app://bundle/index.html');
  } else {
    win.loadURL('http://localhost:3000');
  }
}

let tempServerProcess = null;

function startTempServer() {
  const { spawn } = require('child_process');
  
  // Look for it in the app dir (dev) or process.resourcesPath (packaged)
  const exePaths = [
    path.join(__dirname, 'NeuralMasterTempServer.exe'),
    path.join(process.resourcesPath || '', 'NeuralMasterTempServer.exe')
  ];

  const fs = require('fs');
  let exePath = null;
  for (const p of exePaths) {
    if (fs.existsSync(p)) {
      exePath = p;
      break;
    }
  }

  if (exePath) {
    tempServerProcess = spawn(exePath, [], { 
      detached: true, 
      stdio: 'ignore',
      windowsHide: true 
    });

    tempServerProcess.unref();
    console.log('🌡️ TempServer запущен (LibreHardwareMonitor)');
  } else {
    console.log('⚠️ TempServer.exe не найден. Используем фоллбэки WMI.');
  }
}

app.whenReady().then(() => {
  if (!gotInstanceLock) return; // second instance is quitting — do not open a window

  // Serve dist/ over app://bundle/ (packaged). Path traversal is clamped to
  // the dist root; unknown/escaped paths never reach the filesystem.
  const distRoot = path.normalize(path.join(__dirname, 'dist'));
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

  // The app needs no OS permissions (no mic/camera/notifications/geolocation
  // …). Deny every prompt so no content can request one.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  startTempServer();
  createWindow();

  ipcMain.on('close-app', (event) => {
    app.quit();
  });

  ipcMain.on('minimize-app', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
  });

const si = require('systeminformation');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

let hwInfoCache = null;

// Function to fetch CPU temp directly via WMI as a fallback (often needed for Ryzen)
async function getCpuTempWmiFallback() {
    try {
        const { stdout } = await execPromise('wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature /value', { timeout: 1000 });
        const match = stdout.match(/CurrentTemperature=(\d+)/);
        if (match && match[1]) {
            // WMI returns temp in tenths of degrees Kelvin
            const kelvin = parseInt(match[1], 10) / 10;
            return kelvin - 273.15;
        }
    } catch (e) {}
    // Additional generic fallback via CIM/OpenHardwareMonitor if available
    try {
        const { stdout } = await execPromise('Get-WmiObject -Query "SELECT * FROM Sensor WHERE SensorType=\'Temperature\' AND Name LIKE \'%CPU%\'" -Namespace "root\\OpenHardwareMonitor" | Select-Object -ExpandProperty Value', { 'shell': 'powershell.exe', timeout: 1000 });
        const val = parseFloat(stdout.trim());
        if (!isNaN(val)) return val;
    } catch (e) {}
    return null;
}

  ipcMain.handle('get-hardware-info', async () => {
    if (!hwInfoCache) {
      try {
        const cpu = await si.cpu();
        const gpu = await si.graphics();
        let gpuName = 'GPU';
        if (gpu && gpu.controllers && gpu.controllers.length > 0) {
          // Sort controllers by VRAM descending to prefer discrete GPUs over integrated
          const sortedGpus = [...gpu.controllers].sort((a, b) => (b.vram || 0) - (a.vram || 0));
          gpuName = sortedGpus[0].model;
        }
        hwInfoCache = {
          cpuName: cpu.brand || 'CPU',
          gpuName: gpuName
        };
      } catch (e) {
        hwInfoCache = { cpuName: 'CPU', gpuName: 'GPU' };
      }
    }
    return hwInfoCache;
  });

  ipcMain.handle('get-hardware-temps', async () => {
    // 1) ТРЯТЬ C# СЕРВЕР НАПРЯМУЮ ИЗ NODE.JS (обход CORS!)
    try {
      const http = require('http');
      const data = await new Promise((resolve, reject) => {
        const req = http.get('http://127.0.0.1:51234/', (res) => {
          if (res.statusCode !== 200) return reject();
          let rawData = '';
          res.on('data', (chunk) => rawData += chunk);
          res.on('end', () => resolve(JSON.parse(rawData)));
        });
        req.on('error', reject);
        req.setTimeout(1500, () => req.abort());
      });
      
      // We also need loads
      let cpuLoadRes = null;
      let gpuLoadRes = null;
      try {
         const cl = await si.currentLoad();
         cpuLoadRes = cl.currentLoad;
         const gr = await si.graphics();
         if (gr && gr.controllers && gr.controllers[0]) {
             gpuLoadRes = gr.controllers[0].utilizationGpu;
         }
      } catch(e) {}

      return {
        cpuTemp: data.cpu,
        gpuTemp: data.gpu,
        cpuLoad: cpuLoadRes,
        gpuLoad: gpuLoadRes
      };
    } catch (e) {
      // fallback if C# server is off...
    }

    try {
      // First try standard cpuTemperature
      let cpuTempResult = null;
      let cpuLoadResult = null;
      
      try {
        const cpuTempData = await si.cpuTemperature();
        if (cpuTempData && cpuTempData.main > 0) {
           cpuTempResult = cpuTempData.main;
        } else if (cpuTempData && cpuTempData.max > 0) {
           cpuTempResult = cpuTempData.max;
        } else if (cpuTempData && cpuTempData.cores && cpuTempData.cores.length > 0 && cpuTempData.cores[0] > 0) {
           cpuTempResult = cpuTempData.cores[0];
        } else if (cpuTempData && cpuTempData.socket && cpuTempData.socket.length > 0 && cpuTempData.socket[0] > 0) {
           cpuTempResult = cpuTempData.socket[0];
        }
      } catch (e) {
         // ignore
      }

      if (!cpuTempResult || cpuTempResult < 10) {
         cpuTempResult = await getCpuTempWmiFallback();
      }
      
      // No sensor (e.g. Ryzen without LHM) → cpuTempResult stays null;
      // the UI renders "--°C". We never fabricate a temperature.

      try {
         const cpuLoadData = await si.currentLoad();
         cpuLoadResult = cpuLoadData.currentLoad >= 0 ? cpuLoadData.currentLoad : null;
      } catch (e) {
         // ignore
      }

      let gpuTemp = null;
      let gpuLoad = null;
      
      try {
        const graphics = await si.graphics();
        if (graphics && graphics.controllers) {
          const sortedGpus = [...graphics.controllers].sort((a, b) => (b.vram || 0) - (a.vram || 0));
          // Take from the best GPU
          const bestGpu = sortedGpus[0];
          if (bestGpu) {
            gpuTemp = bestGpu.temperatureReal > 0 ? bestGpu.temperatureReal : (bestGpu.temperatureGpu > 0 ? bestGpu.temperatureGpu : null);
            if (!gpuTemp) {
                // If the best GPU has no temp, search if ANY GPU has temp
                for (const ctrl of graphics.controllers) {
                    if (ctrl.temperatureReal > 0 || ctrl.temperatureGpu > 0) {
                        gpuTemp = ctrl.temperatureReal || ctrl.temperatureGpu;
                        break;
                    }
                }
            }
            gpuLoad = bestGpu.utilizationGpu !== undefined && bestGpu.utilizationGpu !== null ? bestGpu.utilizationGpu : null;
          }
        }
      } catch (e) {
         // ignore
      }
      
      // GPU without a readable temp → gpuTemp stays null ("--°C"), not a fake.

      return {
        cpuTemp: cpuTempResult,
        cpuLoad: cpuLoadResult,
        gpuTemp: gpuTemp,
        gpuLoad: gpuLoad
      };
    } catch (e) {
      return { cpuTemp: null, cpuLoad: null, gpuTemp: null, gpuLoad: null };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  if (tempServerProcess) {
    try { tempServerProcess.kill(); } catch(e) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
