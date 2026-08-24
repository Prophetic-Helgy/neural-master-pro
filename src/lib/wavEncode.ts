/**
 * wavEncode.ts — canonical PCM WAV writer (pure TypeScript, zero dependencies).
 *
 * Supports 16-bit, 24-bit and 32-bit float (IEEE 754, fmt code 3) output.
 * Integer paths can apply TPDF dither (two independent randoms per sample,
 * ±0.5 LSB) — the same rule studio tools use when dithering from float down
 * to integer bit depth, so very quiet material does not get quantization
 * distortion baked into the master.
 *
 * Runs in Node (scripts) and in the browser bundle.
 */

export type WavBitDepth = 16 | 24 | 32;

export interface WavEncodeOptions {
  /** 16 / 24 / 32 (32 = 32-bit float, fmt code 3). */
  bitDepth: WavBitDepth;
  /** Apply TPDF dither on 16/24-bit paths (ignored for 32-bit float). */
  dither?: boolean;
}

/** Deterministic tiny PRNG (mulberry32) — dither noise is reproducible per file. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Encode interleaved stereo (or mono) float32 channels to a WAV Blob/ArrayBuffer.
 * Channels must have equal length; values are hard-clipped to [-1, 1].
 */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  opts: WavEncodeOptions
): ArrayBuffer {
  const numCh = channels.length;
  if (numCh < 1) throw new Error('encodeWav: no channels');
  const length = channels[0].length;
  for (const ch of channels) {
    if (ch.length !== length) throw new Error('encodeWav: channel length mismatch');
  }

  const { bitDepth } = opts;
  const dither = !!opts.dither && bitDepth !== 32;
  const bitsPerSample = bitDepth;
  const bytesPerSample = bitDepth / 8;

  // 32-bit float uses fmt code 3 and does NOT use the LIST chunk; header is 44 bytes.
  const dataBytes = length * numCh * bytesPerSample;
  const view = new DataView(new ArrayBuffer(44));
  let pos = 0;

  const w16 = (v: number) => { view.setUint16(pos, v, true); pos += 2; };
  const w32 = (v: number) => { view.setUint32(pos, v, true); pos += 4; };

  w32(0x46464952);                    // "RIFF"
  w32(36 + dataBytes);                // file size - 8
  w32(0x45564157);                    // "WAVE"
  w32(0x20746d66);                    // "fmt "
  w32(16);                            // fmt chunk size
  w16(bitDepth === 32 ? 3 : 1);       // 3 = IEEE float, 1 = PCM
  w16(numCh);
  w32(sampleRate);
  w32(sampleRate * numCh * bytesPerSample);
  w16(numCh * bytesPerSample);        // block align
  w16(bitsPerSample);
  w32(0x61746164);                    // "data"
  w32(dataBytes);

  const head = view.buffer;
  const out = new Uint8Array(44 + dataBytes);
  out.set(new Uint8Array(head), 0);

  const rand = mulberry32(0x9E3779B9);
  const quantize = (v: number): number => {
    let s = v;
    if (dither) {
      // TPDF: two uniform(-0.5, 0.5) LSBs in normalized scale
      const lsb = 1 / Math.pow(2, bitsPerSample - 1);
      s += (rand() - 0.5) * lsb + (rand() - 0.5) * lsb;
    }
    return Math.max(-1, Math.min(1, s));
  };

  let o = 44;
  for (let i = 0; i < length; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      const s = quantize(channels[c][i]);
      if (bitDepth === 16) {
        const v = Math.max(-32768, Math.min(32767, Math.round(s * 32768)));
        out[o] = v & 0xff;
        out[o + 1] = (v >> 8) & 0xff;
      } else if (bitDepth === 24) {
        const v = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388608)));
        out[o] = v & 0xff;
        out[o + 1] = (v >> 8) & 0xff;
        out[o + 2] = (v >> 16) & 0xff;
      } else {
        // 32-bit float: write as little-endian IEEE 754
        const dv = new DataView(out.buffer, o, 4);
        dv.setFloat32(0, s, true);
      }
      o += bytesPerSample;
    }
  }
  return out.buffer;
}

/** Decode a little-endian 16/24-bit PCM payload back to float32 (round-trip tests). */
export function decodeWavSamples(data: Uint8Array, bitDepth: 16 | 24): Float32Array {
  const bytesPerSample = bitDepth / 8;
  const n = data.length / bytesPerSample;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * bytesPerSample;
    if (bitDepth === 16) {
      const v = data[o] | (data[o + 1] << 8);
      out[i] = (v & 0x8000 ? v | 0xffff0000 : v) / 32768;
    } else {
      let v = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16);
      out[i] = (v & 0x800000 ? v | 0xff000000 : v) / 8388608;
    }
  }
  return out;
}
