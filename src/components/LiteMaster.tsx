/**
 * LiteMaster — one-click platform mastering (the "Lite" mode).
 *
 * Picks a platform preset (or custom LUFS/ceiling/profile), runs the offline
 * masteringPipeline on the loaded track, shows before/after metrics and the
 * auto-detected findings, offers sample-synced A/B compare (hold a side to
 * hear it) and exports WAV / MP3 / FLAC locally. All processing is client-side.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Music4 } from 'lucide-react';
import clsx from 'clsx';
import { zipSync } from 'fflate';
import { i18n } from '../lib/i18n';
import type { Language, TrackMetadata } from '../types';
import type { AudioEngine } from '../lib/AudioEngine';
import { measureMetrics, type PipelineMetrics } from '../lib/audioMeters';
import {
  runMasteringPipeline,
  type PipelineResult,
  type ProfileId,
} from '../lib/masteringPipeline';
import {
  LITE_PRESETS,
  CUSTOM_PRESET_ID,
  DEFAULT_CUSTOM,
  presetToSettings,
  type CustomPresetParams,
} from '../lib/presets';
import {
  encodeAudio,
  type ExportAudioFormat,
  type ExportWavBitDepth,
  type ExportMp3Kbps,
} from '../lib/exportEncoders';

interface LiteMasterProps {
  lang: Language;
  engine: AudioEngine | null;
  trackLoaded: boolean;
  refTrackLoaded: boolean;
  metadata: TrackMetadata;
  isPlaying: boolean;
  onPlaybackChange: (playing: boolean) => void;
  onNotify: (msg: string, kind?: 'error' | 'warn') => void;
}

interface BatchItem {
  id: number;
  name: string;
  file: File;
  status: 'queued' | 'working' | 'done' | 'error';
  pct: number;
  inLufs?: number;
  outLufs?: number;
  /** Mastered audio (kept until the batch is cleared, then GC'd). */
  left?: Float32Array;
  right?: Float32Array;
  sampleRate?: number;
}

const MAX_BATCH_FILES = 20;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

/** Substitute {0}/{1} placeholders from PipelineFinding args. */
function fmt(s: string, args?: string[]): string {
  if (!args) return s;
  return s.replace(/\{(\d)\}/g, (_, i) => args[Number(i)] ?? '');
}

function dbOrDash(v: number, digits = 1): string {
  return v <= -119.9 ? '-∞' : `${v.toFixed(digits)} dB`;
}

const CHIP = "px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest rounded-sm transition-colors border-l border-white/5";
const CHIP_ON = "bg-[var(--accent)] text-black";
const CHIP_OFF = "text-[var(--text-dim)] hover:text-white";

export function LiteMaster({
  lang,
  engine,
  trackLoaded,
  refTrackLoaded,
  metadata,
  isPlaying,
  onPlaybackChange,
  onNotify,
}: LiteMasterProps) {
  const t = i18n[lang];

  const [presetId, setPresetId] = useState<string>(LITE_PRESETS[0].id);
  const [custom, setCustom] = useState<CustomPresetParams>(DEFAULT_CUSTOM);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; stage: string } | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [liveSide, setLiveSide] = useState<'before' | 'after' | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState<number | null>(null);
  const [fmtSel, setFmtSel] = useState<ExportAudioFormat>('wav');
  const [wavBit, setWavBit] = useState<ExportWavBitDepth>(24);
  const [mp3Kbps, setMp3Kbps] = useState<ExportMp3Kbps>(320);
  const [matchRef, setMatchRef] = useState(false);
  const [batch, setBatch] = useState<BatchItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipPct, setZipPct] = useState<number | null>(null);

  const origBufRef = useRef<AudioBuffer | null>(null);
  const outBufRef = useRef<AudioBuffer | null>(null);
  const runIdRef = useRef(0);
  const batchRunIdRef = useRef(0);
  const batchIdRef = useRef(0);
  const batchInputRef = useRef<HTMLInputElement | null>(null);

  /** Reference-track metrics for "match to reference" (null = off). */
  const getRefMetrics = async (): Promise<PipelineMetrics | null> => {
    if (!matchRef || !engine) return null;
    const refBuf = (engine as AudioEngine).getRefBuffer();
    if (!refBuf) return null;
    const l = refBuf.getChannelData(0);
    const r = refBuf.numberOfChannels > 1 ? refBuf.getChannelData(1) : null;
    return measureMetrics(l, r, refBuf.sampleRate);
  };

  // A new track invalidates the previous render and A/B buffers.
  useEffect(() => {
    setResult(null);
    setLiveSide(null);
    origBufRef.current = null;
    outBufRef.current = null;
  }, [metadata.title]);

  const preset = LITE_PRESETS.find((p) => p.id === presetId) ?? null;
  const disabled = running || !engine || !trackLoaded;

  const master = async () => {
    if (disabled) return;
    const eng = engine as AudioEngine;
    const ch = eng.getChannels();
    if (!ch) return;

    const id = ++runIdRef.current;
    setRunning(true);
    setProgress({ pct: 0, stage: 'stageAnalyze' });
    try {
      const refM = await getRefMetrics();
      const res = await runMasteringPipeline({
        left: ch.left,
        right: ch.right,
        sampleRate: ch.sampleRate,
        settings: presetToSettings(preset, custom),
        refMetrics: refM ?? undefined,
        onProgress: (pct, stage) => {
          if (runIdRef.current === id) setProgress({ pct, stage });
        },
      });
      if (runIdRef.current !== id) return;

      // Build preview buffers (the engine never mutates our arrays).
      const mono = ch.right === null;
      const outBuf = new AudioBuffer({ length: res.left.length, sampleRate: ch.sampleRate, numberOfChannels: mono ? 1 : 2 });
      outBuf.copyToChannel(res.left, 0);
      if (!mono) outBuf.copyToChannel(res.right, 1);
      outBufRef.current = outBuf;
      if (!origBufRef.current) {
        const oBuf = new AudioBuffer({ length: ch.left.length, sampleRate: ch.sampleRate, numberOfChannels: mono ? 1 : 2 });
        oBuf.copyToChannel(ch.left, 0);
        if (!mono) oBuf.copyToChannel(ch.right as Float32Array, 1);
        origBufRef.current = oBuf;
      }

      eng.setPreviewBuffer(outBuf, true);
      setResult(res);
      setLiveSide('after');
    } catch (err) {
      console.error('Lite mastering failed', err);
      onNotify(t.liteError, 'error');
    } finally {
      if (runIdRef.current === id) {
        setRunning(false);
        setProgress(null);
      }
    }
  };

  /** Play the given side (starting playback if needed); used for A/B compare. */
  const compare = (side: 'before' | 'after') => {
    if (!result || !engine) return;
    const buf = side === 'before' ? origBufRef.current : outBufRef.current;
    if (!buf) return;
    engine.setPreviewBuffer(buf, true);
    setLiveSide(side);
    if (isPlaying) {
      // A running BufferSource keeps its old buffer — restart the source at the
      // same position so the swap is heard instantly and sample-accurately.
      engine.seek(engine.getCurrentTime());
    } else {
      engine.play();
      onPlaybackChange(true);
    }
  };

  const doExport = async () => {
    if (!result || !outBufRef.current || exporting) return;
    setExporting(true);
    setExportPct(0);
    try {
      const enc = await encodeAudio(
        result.left,
        result.right,
        outBufRef.current.sampleRate,
        {
          format: fmtSel,
          bitDepth: fmtSel === 'wav' ? wavBit : undefined,
          mp3Kbps: fmtSel === 'mp3' ? mp3Kbps : undefined,
          metadata,
          onProgress: (f) => setExportPct(f),
        }
      );
      const base = (metadata.title || 'master').replace(/[^\wЀ-ӿ-]+/g, '_').slice(0, 64) || 'master';
      const url = URL.createObjectURL(enc.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}_mastered.${enc.ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      console.error('Lite export failed', err);
      onNotify(t.liteError, 'error');
    } finally {
      setExporting(false);
      setExportPct(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Batch (sequential queue; per-file progress; fflate ZIP export)
  // ---------------------------------------------------------------------------

  const downloadBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const baseName = (name: string): string =>
    name.replace(/\.[^.]+$/, '').replace(/[^\wЀ-ӿ-]+/g, '_').slice(0, 64) || 'master';

  const encodeOpts = (title: string) => ({
    format: fmtSel,
    bitDepth: fmtSel === 'wav' ? wavBit : undefined,
    mp3Kbps: fmtSel === 'mp3' ? mp3Kbps : undefined,
    metadata: { ...metadata, title },
  });

  const addFiles = (list: FileList | null): void => {
    if (!list || !list.length) return;
    const fresh: BatchItem[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE_BYTES) {
        onNotify(fmt(t.batchLimitSize, [String(MAX_FILE_BYTES / 1048576)]), 'error');
        continue;
      }
      if (batch.length + fresh.length >= MAX_BATCH_FILES) {
        onNotify(fmt(t.batchLimitCount, [String(MAX_BATCH_FILES)]), 'warn');
        break;
      }
      batchIdRef.current += 1;
      fresh.push({ id: batchIdRef.current, name: f.name, file: f, status: 'queued', pct: 0 });
    }
    if (fresh.length) setBatch((prev) => [...prev, ...fresh]);
    if (batchInputRef.current) batchInputRef.current.value = '';
  };

  const patchItem = (id: number, patch: Partial<BatchItem>): void => {
    setBatch((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  const runBatch = async (): Promise<void> => {
    if (!engine || batchRunning) return;
    const eng = engine as AudioEngine;
    const queue = batch.filter((it) => it.status === 'queued' || it.status === 'error');
    if (!queue.length) return;
    const id = ++batchRunIdRef.current;
    setBatchRunning(true);
    try {
      const refM = await getRefMetrics();
      const settings = presetToSettings(preset, custom);
      for (const it of queue) {
        if (batchRunIdRef.current !== id) return;
        patchItem(it.id, { status: 'working', pct: 0, inLufs: undefined, outLufs: undefined });
        try {
          const buf = await eng.getContext().decodeAudioData(await it.file.arrayBuffer());
          if (buf.duration > 20 * 60) throw new Error('too long');
          const l = buf.getChannelData(0);
          const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
          const res = await runMasteringPipeline({
            left: l,
            right: r,
            sampleRate: buf.sampleRate,
            settings,
            refMetrics: refM ?? undefined,
            onProgress: (pct, stage) => {
              if (batchRunIdRef.current === id) patchItem(it.id, { pct });
              void stage;
            },
          });
          if (batchRunIdRef.current !== id) return;
          patchItem(it.id, {
            status: 'done',
            pct: 100,
            inLufs: res.input.integratedLufs,
            outLufs: res.output.integratedLufs,
            left: res.left,
            right: res.right,
            sampleRate: buf.sampleRate,
          });
          // The pipeline copied the channel views — the decoded AudioBuffer
          // is unreferenced now and GC'd, freeing the biggest per-file chunk.
        } catch (err) {
          if (batchRunIdRef.current !== id) return;
          console.error('Batch item failed', it.name, err);
          patchItem(it.id, { status: 'error', pct: 0 });
        }
      }
    } finally {
      if (batchRunIdRef.current === id) setBatchRunning(false);
    }
  };

  const stopBatch = (): void => {
    batchRunIdRef.current += 1;
    setBatchRunning(false);
    // The in-flight file finishes (its guarded writes are no-ops); park it.
    setBatch((prev) => prev.map((it) => (it.status === 'working' ? { ...it, status: 'queued', pct: 0 } : it)));
  };

  const clearBatch = (): void => {
    if (batchRunning) return;
    setBatch([]); // mastered arrays drop out of scope → GC
  };

  const exportItem = async (it: BatchItem): Promise<void> => {
    if (!it.left || !it.right || !it.sampleRate) return;
    try {
      const enc = await encodeAudio(it.left, it.right, it.sampleRate, encodeOpts(baseName(it.name)));
      downloadBlob(enc.blob, `${baseName(it.name)}_mastered.${enc.ext}`);
    } catch (err) {
      console.error('Batch item export failed', err);
      onNotify(t.liteError, 'error');
    }
  };

  const exportZip = async (): Promise<void> => {
    const done = batch.filter((it) => it.status === 'done' && it.left && it.right && it.sampleRate);
    if (!done.length || zipBusy) return;
    setZipBusy(true);
    setZipPct(0);
    try {
      const files: Record<string, Uint8Array> = {};
      const used = new Set<string>();
      for (let i = 0; i < done.length; i += 1) {
        const it = done[i];
        const enc = await encodeAudio(it.left as Float32Array, it.right as Float32Array, it.sampleRate as number, encodeOpts(baseName(it.name)));
        let name = `${baseName(it.name)}_mastered.${enc.ext}`;
        let k = 2;
        while (used.has(name)) name = `${baseName(it.name)}_mastered_${k++}.${enc.ext}`;
        used.add(name);
        files[name] = new Uint8Array(await enc.blob.arrayBuffer());
        setZipPct(((i + 1) / done.length) * 100);
      }
      const zip = zipSync(files);
      const base = (metadata.title || 'masters').replace(/[^\wЀ-ӿ-]+/g, '_').slice(0, 48) || 'masters';
      downloadBlob(new Blob([zip], { type: 'application/zip' }), `${base}_masters.zip`);
    } catch (err) {
      console.error('Batch ZIP export failed', err);
      onNotify(t.liteError, 'error');
    } finally {
      setZipBusy(false);
      setZipPct(null);
    }
  };

  const batchDoneCount = batch.filter((it) => it.status === 'done').length;
  const batchQueuedCount = batch.filter((it) => it.status === 'queued' || it.status === 'error').length;

  const beforeM = result?.input;
  const afterM = result?.output;

  return (
    <div className="bg-[#0a0a0c] border border-[var(--border)] rounded-md p-4 flex flex-col gap-3">
      {/* Header: preset chips */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Music4 size={14} className="text-[var(--accent)]" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-white">{t.modeLite} Master</span>
          <span className="text-[9px] font-mono text-[var(--text-dim)]">
            {preset
              ? `${preset.targetLufs.toFixed(1)} LUFS / ${preset.ceilingDb.toFixed(1)} dBTP`
              : `${custom.targetLufs.toFixed(1)} LUFS / ${custom.ceilingDb.toFixed(1)} dBTP`}
          </span>
        </div>
        <div className="flex bg-black border border-[var(--border)] p-0.5 rounded-sm flex-wrap gap-y-0.5">
          {LITE_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPresetId(p.id)}
              disabled={running}
              className={clsx(CHIP, presetId === p.id ? CHIP_ON : CHIP_OFF, running && 'opacity-40')}
            >
              {(t as Record<string, string>)[p.labelKey]}
            </button>
          ))}
          <button
            onClick={() => setPresetId(CUSTOM_PRESET_ID)}
            disabled={running}
            className={clsx(CHIP, presetId === CUSTOM_PRESET_ID ? CHIP_ON : CHIP_OFF, running && 'opacity-40')}
          >
            {t.presetCustom}
          </button>
        </div>
      </div>

      {/* Custom params */}
      {presetId === CUSTOM_PRESET_ID && (
        <div className="grid grid-cols-3 gap-3 bg-black/40 border border-[var(--border)] rounded-sm p-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[9px] uppercase font-bold tracking-widest text-[var(--text-dim)]">
              {t.customTarget}: <span className="text-[var(--accent)] font-mono">{custom.targetLufs.toFixed(1)}</span>
            </span>
            <input
              type="range" min={-20} max={-8} step={0.5} value={custom.targetLufs}
              onChange={(e) => setCustom({ ...custom, targetLufs: parseFloat(e.target.value) })}
              className="h-1 bg-[#222] rounded-lg appearance-none cursor-pointer"
              style={{ accentColor: 'var(--accent)' }}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[9px] uppercase font-bold tracking-widest text-[var(--text-dim)]">
              {t.customCeiling}: <span className="text-[var(--accent)] font-mono">{custom.ceilingDb.toFixed(1)}</span>
            </span>
            <input
              type="range" min={-3.0} max={-0.3} step={0.1} value={custom.ceilingDb}
              onChange={(e) => setCustom({ ...custom, ceilingDb: parseFloat(e.target.value) })}
              className="h-1 bg-[#222] rounded-lg appearance-none cursor-pointer"
              style={{ accentColor: 'var(--accent)' }}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[9px] uppercase font-bold tracking-widest text-[var(--text-dim)]">{t.customProfile}</span>
            <select
              value={custom.profile}
              onChange={(e) => setCustom({ ...custom, profile: e.target.value as ProfileId })}
              className="bg-[#0c0d11] border border-[var(--border)] rounded-sm text-[10px] font-mono text-white px-1.5 py-1 outline-none"
            >
              {(['balanced', 'streaming', 'loud', 'soft'] as ProfileId[]).map((p) => (
                <option key={p} value={p}>{(t as Record<string, string>)[`profile${p[0].toUpperCase()}${p.slice(1)}`]}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Master button + progress */}
      <div className="flex items-center gap-3">
        <button
          onClick={master}
          disabled={disabled}
          className="px-5 py-2.5 bg-[var(--accent)] text-black text-[11px] font-extrabold uppercase tracking-[2px] rounded-sm hover:brightness-110 active:scale-[0.98] disabled:opacity-30 disabled:grayscale transition-all shadow-[0_0_20px] shadow-[var(--accent)]/10"
        >
          {running && progress ? (t as Record<string, string>)[progress.stage] : t.liteMaster}
        </button>
        {refTrackLoaded && (
          <label className="flex items-center gap-1.5 cursor-pointer select-none shrink-0" title={t.liteMatchRef}>
            <input
              type="checkbox"
              checked={matchRef}
              onChange={(e) => setMatchRef(e.target.checked)}
              disabled={running || batchRunning}
              className="w-3 h-3"
              style={{ accentColor: 'var(--accent)' }}
            />
            <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-dim)]">{t.liteMatchRef}</span>
          </label>
        )}
        {!trackLoaded && <span className="text-[10px] text-[var(--text-dim)]">{t.liteSelectTrack}</span>}
        {running && progress && (
          <div className="flex-1 flex items-center gap-2">
            <div className="flex-1 h-[6px] bg-[#1a1c22] rounded-full overflow-hidden">
              <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${progress.pct}%` }} />
            </div>
            <span className="text-[9px] font-mono text-[var(--accent)] w-8 text-right">{Math.round(progress.pct)}%</span>
          </div>
        )}
        {result && !running && (
          <span className="text-[10px] font-mono text-[var(--accent)]">
            {t.mastered} · {result.renderMs.toFixed(0)} ms
          </span>
        )}
      </div>

      {/* Before / After */}
      {result && beforeM && afterM && (
        <div className="bg-black/40 border border-[var(--border)] rounded-sm p-3">
          <div className="text-[9px] uppercase font-bold tracking-widest text-[var(--accent)] mb-2">
            {t.before} / {t.after}
          </div>
          <div className="grid grid-cols-4 gap-x-4 gap-y-1 font-mono text-[10px]">
            <span className="text-[var(--text-dim)]" />
            <span className="text-[var(--text-dim)] text-right">{t.before}</span>
            <span className="text-[var(--text-dim)] text-right">{t.after}</span>
            <span />
            <span className="text-[var(--text-dim)]">{t.lufs}</span>
            <span className="text-white text-right">{beforeM.integratedLufs.toFixed(2)}</span>
            <span className="text-right" style={{ color: 'var(--accent)' }}>{afterM.integratedLufs.toFixed(2)}</span>
            <span className="text-[var(--text-dim)] text-right">
              {Math.abs(afterM.integratedLufs - beforeM.integratedLufs) < 0.05 ? '' : `${afterM.integratedLufs >= beforeM.integratedLufs ? '+' : ''}${(afterM.integratedLufs - beforeM.integratedLufs).toFixed(2)}`}
            </span>
            <span className="text-[var(--text-dim)]">{t.truePeak}</span>
            <span className="text-white text-right">{beforeM.truePeakDb.toFixed(2)} dBTP</span>
            <span className="text-right" style={{ color: 'var(--accent)' }}>{afterM.truePeakDb.toFixed(2)} dBTP</span>
            <span className="text-[var(--text-dim)] text-right">
              {`${afterM.truePeakDb - beforeM.truePeakDb >= 0 ? '+' : ''}${(afterM.truePeakDb - beforeM.truePeakDb).toFixed(2)}`}
            </span>
            <span className="text-[var(--text-dim)]">{t.lra}</span>
            <span className="text-white text-right">{beforeM.lra.toFixed(2)} LU</span>
            <span className="text-right" style={{ color: 'var(--accent)' }}>{afterM.lra.toFixed(2)} LU</span>
            <span />
            <span className="text-[var(--text-dim)]">{t.crest}</span>
            <span className="text-white text-right">{beforeM.crestDb.toFixed(2)} dB</span>
            <span className="text-right" style={{ color: 'var(--accent)' }}>{afterM.crestDb.toFixed(2)} dB</span>
            <span />
            <span className="text-[var(--text-dim)]">Corr</span>
            <span className="text-white text-right">{beforeM.correlation.toFixed(2)}</span>
            <span className="text-right" style={{ color: 'var(--accent)' }}>{afterM.correlation.toFixed(2)}</span>
            <span />
            <span className="text-[var(--text-dim)]">{t.dcOffset}</span>
            <span className="text-white text-right">{dbOrDash(beforeM.dcOffsetDb)}</span>
            <span className="text-right" style={{ color: 'var(--accent)' }}>{dbOrDash(afterM.dcOffsetDb)}</span>
            <span />
          </div>

          {/* Findings */}
          <div className="mt-3 pt-2 border-t border-white/5 space-y-1">
            {result.findings.map((f, i) => (
              <div key={i} className="flex items-start gap-2 text-[10px]">
                {f.level === 'warn'
                  ? <AlertTriangle size={11} className="text-yellow-400 shrink-0 mt-0.5" />
                  : <CheckCircle2 size={11} className="text-emerald-400 shrink-0 mt-0.5" />}
                <span className={f.level === 'warn' ? 'text-yellow-200/90' : 'text-[var(--text-dim)]'}>
                  {fmt((t as Record<string, string>)[f.key] ?? f.key, f.args)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* A/B compare (hold to hear a side) */}
      {result && (
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-dim)]">A/B</span>
          {(['before', 'after'] as const).map((side) => (
            <button
              key={side}
              onPointerDown={() => compare(side)}
              onPointerUp={() => compare('after')}
              onPointerLeave={() => { if (liveSide === side) compare('after'); }}
              className={clsx(
                "px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest rounded-sm border transition-colors select-none touch-none",
                liveSide === side
                  ? "bg-white text-black border-white"
                  : "bg-[#0a0a0c] border-[var(--border)] text-[var(--text-dim)] hover:text-white"
              )}
            >
              {side === 'before' ? 'A · ' + t.before : 'B · ' + t.after}
            </button>
          ))}
          <span className="text-[9px] font-mono text-[var(--text-dim)]">
            {liveSide ? (liveSide === 'before' ? t.before : t.after) : t.after}
          </span>
        </div>
      )}

      {/* Export */}
      {result && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-black border border-[var(--border)] p-0.5 rounded-sm">
            {(['wav', 'mp3', 'flac'] as ExportAudioFormat[]).map((f) => (
              <button
                key={f}
                onClick={() => setFmtSel(f)}
                className={clsx(CHIP, fmtSel === f ? CHIP_ON : CHIP_OFF)}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
          {fmtSel === 'wav' && (
            <div className="flex bg-black border border-[var(--border)] p-0.5 rounded-sm">
              {([16, 24, 32] as ExportWavBitDepth[]).map((b) => (
                <button
                  key={b}
                  onClick={() => setWavBit(b)}
                  className={clsx(CHIP, wavBit === b ? CHIP_ON : CHIP_OFF)}
                >
                  {b === 32 ? '32f' : `${b}-bit`}
                </button>
              ))}
            </div>
          )}
          {fmtSel === 'mp3' && (
            <div className="flex bg-black border border-[var(--border)] p-0.5 rounded-sm">
              {([192, 320] as ExportMp3Kbps[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setMp3Kbps(k)}
                  className={clsx(CHIP, mp3Kbps === k ? CHIP_ON : CHIP_OFF)}
                >
                  {k}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={doExport}
            disabled={exporting}
            className="flex-1 min-w-[120px] flex items-center justify-center gap-2 px-4 py-2 bg-white/5 border border-[var(--border)] text-white text-[10px] font-bold uppercase tracking-widest rounded-sm hover:bg-white/10 disabled:opacity-40 transition-colors"
          >
            <Download size={12} className="text-[var(--accent)]" />
            {exporting
              ? `${t.exporting} ${Math.round((exportPct ?? 0) * 100)}%`
              : `${t.export} ${fmtSel.toUpperCase()}`}
          </button>
        </div>
      )}

      {/* Batch */}
      <div className="bg-black/40 border border-[var(--border)] rounded-sm p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--accent)]">{t.batch}</span>
          <span className="text-[9px] font-mono text-[var(--text-dim)]">{batch.length}/{MAX_BATCH_FILES}</span>
          <div className="flex-1" />
          <button
            onClick={() => batchInputRef.current?.click()}
            disabled={batchRunning || batch.length >= MAX_BATCH_FILES}
            className={clsx(CHIP, CHIP_OFF, (batchRunning || batch.length >= MAX_BATCH_FILES) && 'opacity-40')}
          >
            {t.batchAdd}
          </button>
          {batchQueuedCount > 0 && !batchRunning && (
            <button
              onClick={runBatch}
              className={clsx(CHIP, CHIP_ON)}
            >
              {t.batchRun}
            </button>
          )}
          {batchRunning && (
            <button onClick={stopBatch} className={clsx(CHIP, CHIP_OFF)}>
              {t.batchStop}
            </button>
          )}
          {batch.length > 0 && !batchRunning && (
            <button onClick={clearBatch} className={clsx(CHIP, CHIP_OFF)}>
              {t.batchClear}
            </button>
          )}
        </div>

        {batch.length > 0 && (
          <div className="mt-2 space-y-1 max-h-44 overflow-y-auto pr-1">
            {batch.map((it) => (
              <div key={it.id} className="flex items-center gap-2 text-[10px] font-mono">
                <span className="flex-1 truncate text-white/80" title={it.name}>{it.name}</span>
                {it.status === 'working' && (
                  <div className="w-16 h-[4px] bg-[#1a1c22] rounded-full overflow-hidden shrink-0">
                    <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${it.pct}%` }} />
                  </div>
                )}
                {it.status === 'queued' && <span className="text-[var(--text-dim)] w-16 text-right shrink-0">{t.batchQueued}</span>}
                {it.status === 'done' && it.inLufs !== undefined && it.outLufs !== undefined && (
                  <span className="text-[var(--accent)] w-24 text-right shrink-0">{it.inLufs.toFixed(1)} → {it.outLufs.toFixed(1)}</span>
                )}
                {it.status === 'error' && <AlertTriangle size={11} className="text-red-400 shrink-0" />}
                {it.status === 'done' && (
                  <button onClick={() => exportItem(it)} title={t.export} className="shrink-0 text-[var(--text-dim)] hover:text-white">
                    <Download size={11} className="text-[var(--accent)]" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {batchDoneCount > 0 && (
          <button
            onClick={exportZip}
            disabled={zipBusy}
            className="mt-2 w-full flex items-center justify-center gap-2 px-3 py-1.5 bg-white/5 border border-[var(--border)] text-white text-[9px] font-bold uppercase tracking-widest rounded-sm hover:bg-white/10 disabled:opacity-40 transition-colors"
          >
            <Download size={11} className="text-[var(--accent)]" />
            {zipBusy
              ? `${t.batchZip} ${Math.round(zipPct ?? 0)}%`
              : `${t.batchZip} · ${fmtSel.toUpperCase()}`}
          </button>
        )}
      </div>

      <input
        ref={batchInputRef}
        type="file"
        accept="audio/*"
        multiple
        className="hidden"
        onChange={(e) => addFiles(e.target.files)}
      />
    </div>
  );
}
