import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
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
