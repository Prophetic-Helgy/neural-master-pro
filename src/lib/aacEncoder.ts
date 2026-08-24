/**
 * aacEncoder.ts — AAC (m4a) export via @ffmpeg/wasm, 100% local core.
 *
 * Why @ffmpeg/wasm: Chrome's WebCodecs AudioEncoder cannot encode AAC
 * (Safari can; mediabunny is WebCodecs-based, so it has no AAC encoder
 * either). The single-threaded @ffmpeg/core carries FFmpeg's built-in
 * `aac` encoder — the only honest client-side AAC path for Chrome.
 *
 * Architecture (pinned @ffmpeg/ffmpeg@0.12.15 + @ffmpeg/core@0.12.10):
 * - The worker is served STATICALLY from public/ffmpeg/ (copied by
 *   copy-ffmpeg.js) and passed via `classWorkerURL`, so the bundler never
 *   touches worker code (avoids the known import(coreURL) hijack, issue #687).
 * - The ~30 MB core (ffmpeg-core.js + .wasm) is read locally — fetch in the
 *   browser / dev Electron, fs.readFileSync in packaged Electron (file://) —
 *   wrapped in Blob URLs and handed to the worker. Zero network requests.
 * - Container is m4a (mp4 mux): the only AAC container that carries
 *   title/artist metadata (udta/meta/ilst); ADTS .aac cannot.
 * - Node.js is NOT supported by @ffmpeg/ffmpeg >= 0.12 (package exports
 *   `node` → stub that throws), so the testable unit here is buildAacArgs;
 *   the real encode is verified in the browser (see scripts/test-audio.ts T20).
 *
 * Memory: the full interleaved PCM lives in the worker's MEMFS
 * (~86 MB/min at 44.1 kHz stereo f32). Normal 3–5 min tracks are fine;
 * very long files (>20 min) are the practical limit. deleteFile() after
 * each encode releases the MEMFS.
 */

import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { EncodedAudio } from './exportEncoders.ts';
import type { TrackMetadata } from '../types.ts';

export type ExportAacKbps = 128 | 256;

/**
 * Build the exact ffmpeg argv for PCM f32le → AAC m4a.
 * Pure function — unit-testable without the wasm core.
 */
export function buildAacArgs(
  sampleRate: number,
  channels: number,
  kbps: ExportAacKbps,
  metadata?: TrackMetadata,
): string[] {
  const args = [
    '-f', 'f32le',
    '-ar', String(sampleRate),
    '-ac', String(channels),
    '-i', 'in.pcm',
    '-c:a', 'aac',
    '-b:a', `${kbps}k`,
  ];
  // Light sanitisation: no control chars, one line, bounded length.
  const tag = (v: string | undefined): string | undefined => {
    if (!v) return undefined;
    const clean = Array.from(v).map((c) => (c.charCodeAt(0) < 32 ? " " : c)).join("").trim().slice(0, 200);
    return clean.length > 0 ? clean : undefined;
  };
  const title = tag(metadata?.title);
  const artist = tag(metadata?.artist);
  if (title) args.push('-metadata', `title=${title}`);
  if (artist) args.push('-metadata', `artist=${artist}`);
  args.push('out.m4a');
  return args;
}

/**
 * Read a local asset (public/ffmpeg/*) as bytes:
 * - packaged Electron (file://, nodeIntegration on): fs.readFileSync
 * - browser / dev Electron (http): fetch
 */
async function localAssetBytes(name: string): Promise<ArrayBuffer> {
  const url = new URL(`ffmpeg/${name}`, document.baseURI).href;
  const w = window as unknown as { require?: (m: string) => unknown };
  if (w.require && typeof location !== 'undefined' && location.protocol === 'file:') {
    const mod = w.require as (m: string) => any;
    const fs = mod('fs');
    const { fileURLToPath } = mod('node:url');
    const buf: Buffer = fs.readFileSync(fileURLToPath(url));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`aacEncoder: cannot load local asset ${name} (${res.status})`);
  return res.arrayBuffer();
}

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoading: Promise<FFmpeg> | null = null;

/**
 * Load (once) the ffmpeg worker + core. Blob URLs are created per load;
 * a failed load resets the singleton so the next call retries cleanly.
 */
function ensureFfmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance) return Promise.resolve(ffmpegInstance);
  if (!ffmpegLoading) {
    ffmpegLoading = (async (): Promise<FFmpeg> => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const ff = new FFmpeg();
      const workerUrl = new URL('ffmpeg/worker.js', document.baseURI).href;
      const coreJsUrl = URL.createObjectURL(
        new Blob([await localAssetBytes('ffmpeg-core.js')], { type: 'text/javascript' }),
      );
      // application/wasm lets emscripten use WebAssembly.instantiateStreaming.
      const coreWasmUrl = URL.createObjectURL(
        new Blob([await localAssetBytes('ffmpeg-core.wasm')], { type: 'application/wasm' }),
      );
      try {
        await ff.load({
          classWorkerURL: workerUrl,
          coreURL: coreJsUrl,
          wasmURL: coreWasmUrl,
        });
      } catch (e) {
        URL.revokeObjectURL(coreJsUrl);
        URL.revokeObjectURL(coreWasmUrl);
        throw e;
      }
      ffmpegInstance = ff;
      return ff;
    })().catch((e) => {
      ffmpegLoading = null; // allow retry
      throw e;
    });
  }
  return ffmpegLoading;
}

/** Preload the AAC core (called when the user picks AAC in the format list). */
export async function preloadAac(): Promise<void> {
  await ensureFfmpeg();
}

/**
 * Encode PCM channels to AAC in an m4a container.
 *
 * @param left   float32 left channel
 * @param right  float32 right channel, or null for mono
 * @param sampleRate  sample rate of the PCM data
 * @param kbps   128 | 256 (CBR)
 * @param metadata  title/artist → m4a udta/meta tags
 * @param onProgress  0..1 as ffmpeg reports it
 */
export async function encodeAac(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
  kbps: ExportAacKbps,
  metadata?: TrackMetadata,
  onProgress?: (fraction: number) => void,
): Promise<EncodedAudio> {
  const ff = await ensureFfmpeg();
  const mono = right === null;
  const channels = mono ? 1 : 2;
  const frames = left.length;

  // Interleave into a FRESH buffer: writeFile transfers it to the worker
  // (detaches it), so source channels must not be passed through.
  const pcm = new Float32Array(frames * channels);
  if (mono) {
    pcm.set(left);
  } else {
    const r = right as Float32Array;
    for (let i = 0; i < frames; i++) {
      pcm[i * 2] = left[i];
      pcm[i * 2 + 1] = r[i];
    }
  }

  const onProg = (d: { progress: number }): void => {
    if (onProgress && Number.isFinite(d.progress) && d.progress >= 0) {
      onProgress(Math.min(1, d.progress));
    }
  };
  ff.on('progress', onProg);
  try {
    await ff.writeFile('in.pcm', new Uint8Array(pcm.buffer));
    const ret = await ff.exec(buildAacArgs(sampleRate, channels, kbps, metadata));
    if (ret !== 0) throw new Error(`AAC encode failed (ffmpeg exit code ${ret})`);
    const out = await ff.readFile('out.m4a', 'binary');
    if (!(out instanceof Uint8Array)) throw new Error('AAC encode: readFile returned unexpected data');
    await ff.deleteFile('in.pcm');
    await ff.deleteFile('out.m4a');
    const bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    return { blob: new Blob([bytes], { type: 'audio/mp4' }), ext: 'm4a', bytes: bytes.byteLength };
  } finally {
    ff.off('progress', onProg);
  }
}
