/**
 * exportEncoders.ts — unified audio export: WAV (16/24/32f) / MP3 / AAC / FLAC.
 *
 * - WAV:  wavEncode.encodeWav (tested, TPDF dither on integer paths).
 * - MP3:  mediabunny + @mediabunny/mp3-encoder (LAME WASM, built-in ID3v2 tags).
 * - AAC:  aacEncoder (lazy import) — @ffmpeg/wasm m4a, core served locally
 *         from public/ffmpeg/, no network. Separate chunk: the ~30 MB core
 *         is a static asset, not part of the main bundle.
 * - FLAC: mediabunny + @mediabunny/flac-encoder (libFLAC WASM, 24-bit,
 *         VORBIS_COMMENT tags). Both wasm payloads are inlined in the
 *         extension bundles, so no extra assets / fetches are needed
 *         (works in the browser bundle and Electron file://).
 *
 * All encoding runs client-side. PCM is fed to mediabunny in ~5 s chunks
 * (backpressure via await source.add()) so multi-minute files do not
 * spike memory or freeze the UI.
 */

import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  FlacOutputFormat,
  Mp3OutputFormat,
  Output,
  Quality,
  canEncodeAudio,
} from 'mediabunny';
import type { MetadataTags } from 'mediabunny';
import { encodeWav, type WavBitDepth } from './wavEncode.ts';
import type { ExportAacKbps } from './aacEncoder.ts';
import type { TrackMetadata } from '../types.ts';

export type ExportAudioFormat = 'wav' | 'mp3' | 'aac' | 'flac';
export type ExportWavBitDepth = WavBitDepth;
export type ExportMp3Kbps = 128 | 192 | 256 | 320;

export interface ExportAudioOptions {
  format: ExportAudioFormat;
  /** WAV only. 16 / 24 / 32 (32 = float). Default 24. */
  bitDepth?: ExportWavBitDepth;
  /** MP3 only. Default 320. */
  mp3Kbps?: ExportMp3Kbps;
  /** AAC only. Default 256. */
  aacKbps?: ExportAacKbps;
  /** RIFF INFO / ID3v2 / VORBIS_COMMENT metadata. */
  metadata?: TrackMetadata;
  /** Called with 0..1 as chunks are fed to the encoder. */
  onProgress?: (fraction: number) => void;
}

export interface EncodedAudio {
  blob: Blob;
  ext: string;
  bytes: number;
}

/** Mediabunny codec extensions are registered lazily, once. */
let encodersReady = false;
async function ensureEncoders(): Promise<void> {
  if (encodersReady) return;
  await Promise.all([
    canEncodeAudio('flac').then((ok) =>
      ok ? null : import('@mediabunny/flac-encoder').then((m) => m.registerFlacEncoder())
    ),
    canEncodeAudio('mp3').then((ok) =>
      ok ? null : import('@mediabunny/mp3-encoder').then((m) => m.registerMp3Encoder())
    ),
  ]);
  encodersReady = true;
}

/** Map TrackMetadata → mediabunny MetadataTags (only fields that are set). */
function toMetadataTags(metadata?: TrackMetadata): MetadataTags | undefined {
  if (!metadata) return undefined;
  const tags: MetadataTags = {};
  const text = (v: string | undefined): string | undefined =>
    v && v.trim() ? v.trim() : undefined;
  const title = text(metadata.title);
  const artist = text(metadata.artist);
  const album = text(metadata.album);
  const genre = text(metadata.genre);
  const label = text(metadata.label);
  let date: Date | undefined;
  const year = text(metadata.year);
  if (year) {
    const y = Number(year.match(/\d{4}/)?.[0] ?? year);
    if (Number.isFinite(y) && y >= 1900 && y <= 2100) date = new Date(Date.UTC(y, 0, 1));
  }
  if (title) tags.title = title;
  if (artist) tags.artist = artist;
  if (album) tags.album = album;
  if (genre) tags.genre = genre;
  if (label) tags.comment = label;
  if (date) tags.date = date;
  return Object.keys(tags).length > 0 ? tags : undefined;
}

const CHUNK_FRAMES = 240_000; // ~5 s at 48 kHz — small interleave allocations

async function yieldToUi(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Encode PCM channels to the requested format.
 *
 * @param left   float32 left channel, hard range not required (mediabunny clamps; WAV clamps itself).
 * @param right  float32 right channel, or null for mono.
 * @param sampleRate  sample rate of the PCM data.
 */
export async function encodeAudio(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
  opts: ExportAudioOptions
): Promise<EncodedAudio> {
  const frames = left.length;
  const mono = right === null;
  const channels = mono ? 1 : 2;

  // ---- WAV: synchronous, dithered, INFO-free (metadata is not carried) ----
  if (opts.format === 'wav') {
    const bitDepth: WavBitDepth = opts.bitDepth ?? 24;
    const data = encodeWav(
      mono ? [left] : [left, right as Float32Array],
      sampleRate,
      { bitDepth, dither: bitDepth !== 32 }
    );
    return {
      blob: new Blob([data], { type: 'audio/wav' }),
      ext: 'wav',
      bytes: data.byteLength,
    };
  }

  // ---- AAC: @ffmpeg/wasm (m4a), lazy import keeps the core out of the main bundle ----
  if (opts.format === 'aac') {
    const { encodeAac } = await import('./aacEncoder.ts');
    return encodeAac(left, right, sampleRate, opts.aacKbps ?? 256, opts.metadata, opts.onProgress);
  }

  await ensureEncoders();

  const isMp3 = opts.format === 'mp3';
  const kbps = opts.mp3Kbps ?? 320;
  const output = new Output({
    format: isMp3
      ? new Mp3OutputFormat()
      : new FlacOutputFormat(),
    target: new BufferTarget(),
  });
  const source = new AudioSampleSource({
    codec: isMp3 ? 'mp3' : 'flac',
    quality: new Quality({ bitrate: kbps * 1000, bitrateMode: 'constant' }),
  });
  output.addAudioTrack(source);
  const tags = toMetadataTags(opts.metadata);
  if (tags) output.setMetadataTags(tags);
  await output.start();

  for (let start = 0; start < frames; start += CHUNK_FRAMES) {
    const end = Math.min(frames, start + CHUNK_FRAMES);
    const n = end - start;
    const pcm = new Float32Array(n * channels);
    if (mono) {
      pcm.set(left.subarray(start, end));
    } else {
      const r = right as Float32Array;
      for (let i = 0; i < n; i++) {
        pcm[i * 2] = left[start + i];
        pcm[i * 2 + 1] = r[start + i];
      }
    }
    const sample = new AudioSample({
      data: pcm,
      format: 'f32',
      numberOfChannels: channels,
      sampleRate,
      timestamp: start / sampleRate,
    });
    await source.add(sample);
    sample.close(); // release the PCM buffer once the encoder consumed it
    opts.onProgress?.(Math.min(1, end / frames));
    await yieldToUi();
  }

  source.close();
  await output.finalize();

  const buffer = output.target.buffer;
  if (!buffer) throw new Error('encodeAudio: encoder produced no data');
  // BufferTarget reuses its ArrayBuffer — copy so the caller owns the bytes.
  const bytes = new Uint8Array(buffer).slice();
  return {
    blob: new Blob([bytes], { type: isMp3 ? 'audio/mpeg' : 'audio/flac' }),
    ext: isMp3 ? 'mp3' : 'flac',
    bytes: bytes.byteLength,
  };
}

/** File-name-safe extension map for UI previews. */
export const AUDIO_MIME: Record<ExportAudioFormat, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  aac: 'audio/mp4',
  flac: 'audio/flac',
};
