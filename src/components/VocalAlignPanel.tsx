/**
 * VocalAlignPanel.tsx — Pro-only «VOCAL ALIGN» block (VocAlign-style
 * guide/dub sync, genre of the k1romusic tool). Runs audioAlign.ts
 * (envelope onsets + WSOLA — envelope/energy alignment, pitch-preserving)
 * in an inline worker with a silent main-thread fallback, the same
 * triple-boot pattern as metricsWorker. Independent of the master chain:
 * own uploads, own previews, own downloads. 100% offline.
 */
import React, { useEffect, useRef, useState } from 'react';
import VocalAlignWorker from '../lib/vocalAlignWorker?worker&inline';
import { alignVocal, linearResample, toMono } from '../lib/audioAlign';
import type { AlignWorkerResponse } from '../lib/vocalAlignWorker';
import { encodeAudio } from '../lib/exportEncoders';

interface Mono { data: Float32Array; sr: number }

let alignWorker: Worker | null = null;
let alignWorkerDead = false;
function getAlignWorker(): Worker | null {
  if (alignWorkerDead) return null;
  if (!alignWorker) {
    try { alignWorker = new VocalAlignWorker(); } catch { alignWorkerDead = true; return null; }
    alignWorker.onerror = () => {
      alignWorkerDead = true;
      try { alignWorker?.terminate(); } catch { /* ignore */ }
      alignWorker = null;
    };
  }
  return alignWorker;
}

async function decodeMonoFile(file: File): Promise<Mono> {
  const ab = await file.arrayBuffer();
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ac = new AC();
  try {
    const buf = await ac.decodeAudioData(ab);
    const ch0 = buf.getChannelData(0);
    const data = buf.numberOfChannels > 1 ? toMono(ch0, buf.getChannelData(1)) : new Float32Array(ch0);
    return { data, sr: buf.sampleRate };
  } finally {
    ac.close().catch(() => { /* ignore */ });
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const VocalAlignPanel: React.FC<{
  t: any;
  bitDepth: 16 | 24 | 32;
  showToast: (msg: string, kind?: 'error' | 'warn') => void;
}> = ({ t, bitDepth, showToast }) => {
  const [guide, setGuide] = useState<Mono | null>(null);
  const [dub, setDub] = useState<Mono | null>(null);
  const [names, setNames] = useState<{ g?: string; d?: string }>({});
  const [strength, setStrength] = useState(70);
  const [maxStretch, setMaxStretch] = useState(2);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ mono: Mono; url: string; blob: Blob } | null>(null);
  const [previews, setPreviews] = useState<{ g?: string; d?: string }>({});
  const reqId = useRef(0);
  const urlsRef = useRef<string[]>([]);
  useEffect(() => () => { urlsRef.current.forEach((u) => URL.revokeObjectURL(u)); }, []);
  const mkUrl = (url: string) => { urlsRef.current.push(url); return url; };

  const onFile = async (which: 'g' | 'd', file: File | null) => {
    if (!file) return;
    try {
      const mono = await decodeMonoFile(file);
      const enc = await encodeAudio(mono.data, null, mono.sr, { format: 'wav', bitDepth: 16 });
      const url = mkUrl(URL.createObjectURL(enc.blob));
      if (which === 'g') {
        setGuide(mono); setNames((p) => ({ ...p, g: file.name }));
        setPreviews((p) => { if (p.g) URL.revokeObjectURL(p.g); return { ...p, g: url }; });
      } else {
        setDub(mono); setNames((p) => ({ ...p, d: file.name }));
        setPreviews((p) => { if (p.d) URL.revokeObjectURL(p.d); return { ...p, d: url }; });
      }
      if (out) { URL.revokeObjectURL(out.url); setOut(null); }
    } catch (err) {
      showToast(`${(t as any).vocalAlign || 'VOCAL ALIGN'}: ${String(err)}`);
    }
  };

  const applyAlign = async () => {
    if (!guide || !dub || busy) return;
    setBusy(true);
    try {
      const sr = guide.sr;
      const dubR = dub.sr === sr ? dub.data
        : linearResample(dub.data, Math.round((dub.data.length * sr) / dub.sr));
      const req = {
        reqId: ++reqId.current, guide: guide.data, dub: dubR, sampleRate: sr,
        strength: strength / 100, maxStretch,
      };
      const runMainThread = async () => {
        // let the busy state paint first; alignment is O(n) but chunk-yielded by the browser
        await new Promise((r) => setTimeout(r, 0));
        const result = alignVocal(req.guide, req.dub, req.sampleRate, req.strength, req.maxStretch);
        return { reqId: req.reqId, ok: true, result } as AlignWorkerResponse;
      };
      const worker = getAlignWorker();
      let res: AlignWorkerResponse | null;
      if (worker) {
        res = await new Promise<AlignWorkerResponse>((resolve, reject) => {
          const onMsg = (e: MessageEvent<AlignWorkerResponse>) => {
            if (e.data?.reqId !== req.reqId) return;
            clearTimeout(to);
            worker.removeEventListener('message', onMsg);
            resolve(e.data);
          };
          const to = setTimeout(() => {
            worker.removeEventListener('message', onMsg);
            reject(new Error('align timeout'));
          }, 120000);
          worker.addEventListener('message', onMsg);
          try {
            worker.postMessage(req);
          } catch (err) {
            clearTimeout(to);
            worker.removeEventListener('message', onMsg);
            reject(err as Error);
          }
        }).catch(async (err) => {
          // worker died mid-flight → silent main-thread fallback
          console.debug('[vocal-align] worker path failed, main-thread fallback:', err);
          alignWorkerDead = true;
          try { alignWorker?.terminate(); } catch { /* ignore */ }
          alignWorker = null;
          return runMainThread();
        });
      } else {
        res = await runMainThread();
      }
      if (!res?.ok || !res.result) throw new Error(res?.error || 'align failed');
      if (out) URL.revokeObjectURL(out.url);
      const enc = await encodeAudio(res.result.aligned, null, sr, { format: 'wav', bitDepth });
      setOut({
        mono: { data: res.result.aligned, sr },
        url: mkUrl(URL.createObjectURL(enc.blob)),
        blob: enc.blob,
      });
    } catch (err) {
      showToast(`${(t as any).vocalAlign || 'VOCAL ALIGN'}: ${String(err)}`);
      setOut(null);
    } finally {
      setBusy(false);
    }
  };

  const downloadMix = async () => {
    if (!out || !guide) return;
    const n = Math.min(guide.data.length, out.mono.data.length);
    const mix = new Float32Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) { mix[i] = guide.data[i] + out.mono.data[i]; peak = Math.max(peak, Math.abs(mix[i])); }
    if (peak > 0.95) for (let i = 0; i < n; i++) mix[i] *= 0.95 / peak;
    const enc = await encodeAudio(mix, null, out.mono.sr, { format: 'wav', bitDepth });
    downloadBlob(enc.blob, 'VocalAlign_mix.wav');
  };

  const uploadSlot = (which: 'g' | 'd', label: string) => (
    <label className="flex flex-col gap-1 p-2 border border-[var(--border)] rounded-sm bg-[#090a0c] cursor-pointer hover:border-[var(--accent)] transition-colors">
      <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--accent)]">{label}</span>
      <span className="text-[10px] text-[var(--text-dim)] truncate">{(which === 'g' ? names.g : names.d) || '—'}</span>
      <input
        type="file" accept="audio/*" className="hidden"
        data-testid={which === 'g' ? 'align-guide-input' : 'align-dub-input'}
        onChange={(e) => onFile(which, e.target.files?.[0] ?? null)}
      />
    </label>
  );

  return (
    <div className="border-t border-[#222] pt-2 mt-2 flex flex-col gap-2">
      <div className="flex justify-between items-center">
        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>
          {t.vocalAlign || 'VOCAL ALIGN'}
        </span>
        <button
          data-testid="align-apply"
          disabled={!guide || !dub || busy}
          onClick={applyAlign}
          className="text-[9px] font-bold text-black bg-[var(--accent)] hover:bg-[#00cccc] px-3 py-1 rounded-sm uppercase tracking-wider disabled:opacity-30 disabled:grayscale transition-all"
        >
          {busy ? '…' : (t.alignApply || 'APPLY')}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {uploadSlot('g', t.alignGuide || 'GUIDE')}
        {uploadSlot('d', t.alignDub || 'DUB')}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <div className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-dim)]">{t.alignStrength || 'Strength'}</div>
          <input type="range" min="0" max="100" step="1" value={strength}
            onChange={(e) => setStrength(parseFloat(e.target.value))}
            className="w-full h-1 bg-[#222] rounded-lg appearance-none cursor-pointer" style={{ accentColor: 'var(--accent)' }} />
          <div className="text-[9px] font-mono text-[var(--text-dim)]">{strength}%</div>
        </div>
        <div className="flex flex-col gap-1">
          <div className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-dim)]">{t.alignStretch || 'Max Stretch'}</div>
          <input type="range" min="1" max="3" step="0.1" value={maxStretch}
            onChange={(e) => setMaxStretch(parseFloat(e.target.value))}
            className="w-full h-1 bg-[#222] rounded-lg appearance-none cursor-pointer" style={{ accentColor: 'var(--accent)' }} />
          <div className="text-[9px] font-mono text-[var(--text-dim)]">×{maxStretch.toFixed(1)}</div>
        </div>
      </div>
      {(!guide || !dub) && (
        <div className="text-[9px] text-[var(--text-dim)]">{t.alignHint || 'Load a guide and a dub to align'}</div>
      )}
      <div className="flex flex-col gap-1">
        {[
          { label: t.alignGuide || 'GUIDE', url: previews.g },
          { label: t.alignDub || 'DUB', url: previews.d },
          { label: t.alignOut || 'ALIGNED', url: out?.url },
        ].filter((p) => p.url).map((p) => (
          <div key={p.label} className="flex items-center gap-2">
            <span className="text-[8px] font-bold uppercase w-[52px] shrink-0 text-[var(--text-dim)]">{p.label}</span>
            <audio controls preload="none" src={p.url} className="h-7 w-full min-w-0" />
          </div>
        ))}
      </div>
      {out && (
        <div className="flex gap-2">
          <button
            data-testid="align-dl-aligned"
            onClick={() => downloadBlob(out.blob, 'VocalAlign_aligned.wav')}
            className="flex-1 text-[9px] font-bold py-1.5 rounded-sm border border-[var(--border)] text-[var(--text-dim)] hover:text-white transition-colors"
          >
            {t.alignDlAligned || 'WAV ⬇'}
          </button>
          <button
            onClick={downloadMix}
            className="flex-1 text-[9px] font-bold py-1.5 rounded-sm border border-[var(--border)] text-[var(--text-dim)] hover:text-white transition-colors"
          >
            {t.alignDlMix || 'MIX ⬇'}
          </button>
        </div>
      )}
    </div>
  );
};

export default VocalAlignPanel;
