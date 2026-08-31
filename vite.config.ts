import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The strict CSP lives in index.html. In dev only, @vitejs/plugin-react
// injects an inline react-refresh preamble that script-src 'self' would
// block — relax just that directive while serving.
const cspDev = {
  name: 'csp-dev-relax',
  apply: 'serve' as const,
  transformIndexHtml: (html: string) =>
    html.replace(
      "script-src 'self' 'wasm-unsafe-eval' blob:;",
      "script-src 'self' 'wasm-unsafe-eval' blob: 'unsafe-inline';"
    ),
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cspDev,
  ],
  // ASR worker (asrWorker.ts) bundles @huggingface/transformers, whose
  // onnxruntime-web entry code-splits; the default "iife" worker format
  // rejects code-splitting builds. ES + { type: 'module' } (as spawned in
  // asrClient.ts) works in Chromium/Electron, also under file://.
  worker: {
    format: 'es' as const,
  },
  build: {
    minify: false, // Fixes "Qe is not defined" and AudioWorklet errors with Faust in prod
    rollupOptions: {
      external: ['fs', 'path', 'url'], // Prevent Vite from trying to bundle Node modules for browser
    }
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    hmr: false,
  },
  // Set base to './' so it loads correctly in Electron via file:// protocol
  base: './',
  optimizeDeps: {
    // @ffmpeg/ffmpeg must be served as raw ESM (its worker pattern breaks
    // under esbuild prebundling — official react-vite-app does the same)
    exclude: ['@ffmpeg/ffmpeg'],
  },
});
