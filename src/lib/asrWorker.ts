/**
 * asrWorker.ts — Whisper ASR in a file-based module worker (vite
 * `new Worker(new URL(...), {type:'module'})` — the aacEncoder chunk
 * pattern, proven under app://bundle by the packaged smoke).
 *
 * The model ships inside the EXE (public/models/whisper-base, ~78 MB,
 * fetched by scripts/fetch-whisper-model.mjs before build:exe). We hard-
 * disable remote model loading: recognition NEVER touches the network.
 * Device: WebGPU when available, honest WASM fallback otherwise.
 */
/// <reference lib="webworker" />
import { groupWordsIntoSegments, type SubtitleSegment } from './subtitles';

type InMsg = { type: 'transcribe'; id: number; samples: Float32Array; sampleRate: number };
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

let pipePromise: Promise<any> | null = null;

async function getPipeline(): Promise<any> {
  if (pipePromise) return pipePromise;
  pipePromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;      // model is bundled — never remote
    env.allowLocalModels = true;
    // MUST be a scheme-LESS path: transformers.js probes tokenizer/preprocessor
    // existence via a metadata check that only fetches when the resolved path is
    // NOT an http(s) URL (http paths + allowRemoteModels=false read as
    // "file missing" → tokenizer/processor silently null). A relative path is
    // fetch-resolved against the worker origin, which is exactly the server
    // root that serves public/. Prod: the chunk lives in assets/ →
    // '../models/' = app://bundle/models/whisper-base (app:// is not http, so
    // the probe fetches it — proven by the packaged smoke).
    env.localModelPath = import.meta.env.DEV
      ? '/models/'
      : new URL('../models/', import.meta.url).href;
    post({ type: 'status', phase: 'loading' });
    const opts = { dtype: 'q8' as const };
    try {
      return await pipeline('automatic-speech-recognition', 'whisper-base', { ...opts, device: 'webgpu' });
    } catch {
      post({ type: 'status', phase: 'loading-wasm' });
      return pipeline('automatic-speech-recognition', 'whisper-base', { ...opts, device: 'wasm' });
    }
  })().catch((e) => { pipePromise = null; throw e; });
  return pipePromise;
}

/** Linear resample to 16 kHz mono (Whisper's front-end rate). */
function resample16k(samples: Float32Array, sr: number): Float32Array {
  if (sr === 16000) return samples;
  const ratio = sr / 16000;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const f = src - i0;
    out[i] = samples[i0] * (1 - f) + samples[i1] * f;
  }
  return out;
}

async function transcribe(msg: InMsg) {
  const asr = await getPipeline();
  post({ type: 'status', phase: 'transcribing' });
  const audio = resample16k(msg.samples, msg.sampleRate);
  const common = { chunk_length_s: 30, stride_length_s: 5 };
  let out: any = null;
  try {
    out = await asr(audio, { ...common, return_timestamps: 'word' });
  } catch {
    out = null;
  }
  if (out === null) {
    // Some setups reject word-level alignment — re-run at segment level
    // (word karaoke spans are then interpolated by the UI, wordSpans() in
    // subtitles.ts).
    try {
      out = await asr(audio, common);
    } catch {
      out = null;
    }
  }
  let segments: SubtitleSegment[] = [];
  if (out && Array.isArray(out.chunks) && out.chunks.length) {
    // word (or segment) chunks → readable lines
    segments = groupWordsIntoSegments(
      out.chunks.map((c: any) => ({ text: c.text, start: c.timestamp?.[0] ?? null, end: c.timestamp?.[1] ?? null })),
    );
  } else if (out && (typeof out.text === 'string' ? out.text.trim() : out?.length)) {
    // plain text with no usable chunks — one line spanning the audio
    if (!segments.length && typeof out.text === 'string' && out.text.trim()) {
      const n = Math.max(1, Math.floor(audio.length / 16000));
      segments = [{ start: 0, end: n, text: out.text.trim() }];
    }
  }
  post({ type: 'done', id: msg.id, segments });
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'transcribe') return;
  try {
    await transcribe(msg);
  } catch (e: any) {
    post({ type: 'error', id: msg.id, message: String(e?.message || e) });
  }
};
