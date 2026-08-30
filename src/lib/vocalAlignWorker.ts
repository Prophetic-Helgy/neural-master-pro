/**
 * vocalAlignWorker.ts — runs the Vocal Align DSP (envelope onsets, WSOLA
 * stretch) OFF the main thread. Same `?worker&inline` boot as metricsWorker
 * (base64 blob → works from file:// in the packaged build); App.tsx keeps a
 * silent main-thread fallback if the worker cannot start.
 */
import { alignVocal, type AlignResult } from './audioAlign';

export interface AlignWorkerRequest {
  reqId: number;
  guide: Float32Array;
  dub: Float32Array;
  sampleRate: number;
  strength: number;
  maxStretch: number;
}

export interface AlignWorkerResponse {
  reqId: number;
  ok: boolean;
  result?: AlignResult;
  error?: string;
}

self.onmessage = (e: MessageEvent<AlignWorkerRequest>) => {
  const { reqId, guide, dub, sampleRate, strength, maxStretch } = e.data;
  try {
    const result = alignVocal(guide, dub, sampleRate, strength, maxStretch);
    const msg: AlignWorkerResponse = { reqId, ok: true, result };
    (self as unknown as Worker).postMessage(msg, [result.aligned.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ reqId, ok: false, error: String(err) } satisfies AlignWorkerResponse);
  }
};
