/**
 * asrClient.ts — main-thread facade over asrWorker.
 *
 * Lazy worker spawn (first recognition pays the model load ~2-5 s); one
 * request at a time; on error the worker is terminated so a retry starts
 * clean (no silent main-thread fallback — the UI shows the failure and a
 * retry button).
 */
import type { SubtitleSegment } from './subtitles';

export type AsrStatus = { phase: 'loading' | 'loading-wasm' | 'transcribing' };

let worker: Worker | null = null;
let seq = 0;
let activeStatus: ((s: AsrStatus) => void) | null = null;
const pending = new Map<number, { resolve: (s: SubtitleSegment[]) => void; reject: (e: Error) => void }>();

function dropWorker() {
  worker?.terminate();
  worker = null;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./asrWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { type: string; id?: number; segments?: SubtitleSegment[]; message?: string; phase?: string };
    if (m.type === 'status') { activeStatus?.({ phase: m.phase as AsrStatus['phase'] }); return; }
    if (m.id == null) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'done') p.resolve(m.segments || []);
    else if (m.type === 'error') { p.reject(new Error(m.message || 'ASR failed')); dropWorker(); }
  };
  worker.onerror = () => {
    for (const p of pending.values()) p.reject(new Error('ASR worker crashed'));
    pending.clear();
    dropWorker();
  };
  return worker;
}

/**
 * Recognize lyrics from region audio. samples: mono Float32 (any rate),
 * returned segment timings are seconds from the SAME sample-0 (region start).
 */
export function recognizeLyrics(
  samples: Float32Array,
  sampleRate: number,
  onStatus?: (s: AsrStatus) => void,
): Promise<SubtitleSegment[]> {
  return new Promise((resolve, reject) => {
    const w = ensureWorker();
    activeStatus = onStatus || null;
    const id = ++seq;
    pending.set(id, {
      resolve: (s) => { activeStatus = null; resolve(s); },
      reject: (e) => { activeStatus = null; reject(e); },
    });
    // copy + no transfer: the caller keeps its buffer (cue-pass PCM is reused)
    w.postMessage({ type: 'transcribe', id, samples: new Float32Array(samples), sampleRate });
  });
}
