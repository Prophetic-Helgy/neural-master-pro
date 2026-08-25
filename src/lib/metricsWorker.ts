/**
 * metricsWorker.ts — runs the heavy pre-mastering metrics pass (4x true peak,
 * BS.1770-4 LUFS/LRA, tone analysis) OFF the main thread.
 *
 * Bundled via `?worker&inline` (base64 blob) so it also boots from file://
 * in the packaged Electron build. audioMeters.ts is browser-free on purpose,
 * so the same functions run here and in scripts/test-audio.ts.
 */
import { measureMetrics, type PipelineMetrics } from './audioMeters';

export interface MetricsWorkerRequest {
  left: Float32Array;
  right: Float32Array | null;
  sampleRate: number;
}

export interface MetricsWorkerResponse {
  ok: boolean;
  metrics?: PipelineMetrics;
  error?: string;
}

self.onmessage = async (e: MessageEvent<MetricsWorkerRequest>) => {
  try {
    const { left, right, sampleRate } = e.data;
    const metrics = await measureMetrics(left, right, sampleRate);
    (self as unknown as Worker).postMessage({ ok: true, metrics } satisfies MetricsWorkerResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String(err) } satisfies MetricsWorkerResponse);
  }
};
