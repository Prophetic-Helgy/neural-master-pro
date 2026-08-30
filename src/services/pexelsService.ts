/**
 * Pexels stock-video service for clip production backgrounds.
 * Modelled on MoneyPrinterTurbo's material.py: search -> rendition pick ->
 * cached download with validation.
 *
 * NOTE: no API key ships with the app — users paste their own Pexels key into
 * the video-backgrounds panel; it is stored locally in
 * localStorage['nmp_pexels_key']. The key itself is never logged.
 */
import { PexelsClip, PexelsVideoFile } from '../types';

const DEFAULT_PEXELS_KEY = '';
const API_BASE = 'https://api.pexels.com/v1';
const KEY_STORAGE = 'nmp_pexels_key';
// Max background clips per export. Each clip runs a full <video> decoder,
// so 4 x 1080p is comfortable; 4 x 4K at 60 fps is at the edge of what a
// mid-range GPU sustains (the manual-check case, documented in the README).
export const MAX_PEXELS_CLIPS = 4;
const MIN_CLIP_SIZE = 10000; // bytes — anything smaller is treated as a broken download
const CACHE_MAX_FILES = 20;
const SEARCH_TTL_MS = 24 * 3600 * 1000;
const SEARCH_CACHE_MAX = 50;
const DOWNLOAD_TIMEOUT_MS = 300000;

export class PexelsApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PexelsApiError';
    this.code = code;
  }
}

const getKey = (): string => {
  try {
    return localStorage.getItem(KEY_STORAGE) || DEFAULT_PEXELS_KEY;
  } catch {
    return DEFAULT_PEXELS_KEY;
  }
};

/** Whether the user has provided a Pexels API key (none ships with the app). */
export const hasPexelsKey = (): boolean => getKey().length > 0;

/** Store the user's Pexels API key locally (localStorage only). */
export const setPexelsKey = (key: string): void => {
  try {
    const v = key.trim();
    if (v) localStorage.setItem(KEY_STORAGE, v);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable (private mode) — feature simply stays disabled */
  }
};

// ---------- Search (in-memory cache, TTL 24h, empty results not cached) ----------

interface SearchCacheEntry {
  at: number;
  results: PexelsClip[];
}
const searchCache = new Map<string, SearchCacheEntry>();

export const searchPexelsVideos = async (
  query: string,
  orientation: 'portrait' | 'landscape'
): Promise<PexelsClip[]> => {
  const q = query.trim();
  if (!q) return [];
  const cacheKey = `${orientation}|${q.toLowerCase()}`;
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.results;

  const params = new URLSearchParams({ query: q, per_page: '20', orientation });
  const res = await fetch(`${API_BASE}/videos/search?${params}`, {
    headers: { Authorization: getKey() },
  });
  if (res.status === 401) throw new PexelsApiError('401', 'Invalid API key');
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after') || 0);
    throw new PexelsApiError('429', `Rate limited — retry in ${ra || 60}s`);
  }
  if (!res.ok) throw new PexelsApiError(String(res.status), `HTTP ${res.status}`);

  const json = await res.json();
  const results: PexelsClip[] = Array.isArray(json?.videos) ? json.videos : [];
  if (results.length > 0) {
    if (searchCache.size >= SEARCH_CACHE_MAX) {
      const oldest = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) searchCache.delete(oldest[0]);
    }
    searchCache.set(cacheKey, { at: Date.now(), results });
  }
  return results;
};

// ---------- Rendition picking ----------

export const pickBestRendition = (
  files: PexelsVideoFile[] | undefined,
  targetW: number,
  targetH: number
): PexelsVideoFile | null => {
  if (!files || files.length === 0) return null;
  const valid = files.filter(f => f.width > 0 && f.height > 0);
  if (valid.length === 0) return null;

  const exact = valid.find(f => f.width === targetW && f.height === targetH);
  if (exact) return exact;

  // Prefer the smallest rendition that still covers the target (downscale source)
  const larger = valid
    .filter(f => f.width >= targetW && f.height >= targetH)
    .sort((a, b) => a.width * a.height - b.width * b.height);
  if (larger.length > 0) return larger[0];

  // Otherwise the largest rendition below the target
  const smaller = valid
    .filter(f => f.width < targetW && f.height < targetH)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  if (smaller.length > 0) return smaller[0];

  // Fallback: closest aspect ratio, then largest
  const targetRatio = targetW / targetH;
  return [...valid].sort((a, b) => {
    const da = Math.abs(a.width / a.height - targetRatio);
    const db = Math.abs(b.width / b.height - targetRatio);
    return da !== db ? da - db : b.width * b.height - a.width * a.height;
  })[0];
};

// ---------- File cache (fs in <userData>/pexels-cache, in-memory fallback) ----------

interface NodeModules {
  fs: any;
  path: any;
  os: any;
  process: any;
}

const getNodeModules = (): NodeModules | null => {
  try {
    const g: any = globalThis as any;
    if (typeof g?.require !== 'function') return null;
    return { fs: g.require('fs'), path: g.require('path'), os: g.require('os'), process: g.process };
  } catch {
    return null;
  }
};

const getCacheDir = (m: NodeModules): string => {
  let base: string;
  if (m.os.platform() === 'win32') {
    base = m.process?.env?.APPDATA || m.process?.env?.LOCALAPPDATA || m.os.homedir();
  } else if (m.os.platform() === 'darwin') {
    base = m.path.join(m.os.homedir(), 'Library', 'Application Support');
  } else {
    base = m.path.join(m.os.homedir(), '.config');
  }
  return m.path.join(base, 'NeuralMasterPro', 'pexels-cache');
};

const evictCache = (m: NodeModules, dir: string) => {
  try {
    const entries: { p: string; mtime: number }[] = m.fs.readdirSync(dir).map((name: string) => {
      const p = m.path.join(dir, name);
      const st = m.fs.statSync(p);
      return { p, mtime: st.mtimeMs };
    });
    if (entries.length <= CACHE_MAX_FILES) return;
    entries.sort((a, b) => a.mtime - b.mtime);
    for (let i = 0; i < entries.length - CACHE_MAX_FILES; i++) {
      try {
        m.fs.unlinkSync(entries[i].p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
};

const hashLink = (link: string): string => {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < link.length; i++) {
    const c = link.charCodeAt(i);
    h1 = (h1 * 33 + c) >>> 0;
    h2 = (h2 * 31 + c) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
};

// Fallback cache for pure-browser context (no Node integration)
const memCache = new Map<string, Blob>();

const readCacheFile = async (hash: string): Promise<Blob | null> => {
  const m = getNodeModules();
  try {
    if (m) {
      const dir = getCacheDir(m);
      const file = m.path.join(dir, `clip-${hash}.mp4`);
      if (!m.fs.existsSync(file)) return null;
      const st = m.fs.statSync(file);
      if (st.size < MIN_CLIP_SIZE) {
        try {
          m.fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
        return null;
      }
      const buf = m.fs.readFileSync(file);
      evictCache(m, dir);
      return new Blob([buf], { type: 'video/mp4' });
    }
    const mem = memCache.get(hash);
    if (!mem) return null;
    if (mem.size < MIN_CLIP_SIZE) {
      memCache.delete(hash);
      return null;
    }
    memCache.delete(hash);
    memCache.set(hash, mem); // touch for LRU
    return mem;
  } catch {
    return null;
  }
};

const writeCacheFile = (hash: string, blob: Blob) => {
  const m = getNodeModules();
  if (!m) {
    memCache.set(hash, blob);
    const keys = [...memCache.keys()];
    if (keys.length > CACHE_MAX_FILES) memCache.delete(keys[0]);
    return;
  }
  const dir = getCacheDir(m);
  const file = m.path.join(dir, `clip-${hash}.mp4`);
  const tmp = `${file}.tmp-${Date.now()}`;
  void (async () => {
    try {
      m.fs.mkdirSync(dir, { recursive: true });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      m.fs.writeFileSync(tmp, bytes);
      m.fs.renameSync(tmp, file);
      evictCache(m, dir);
    } catch (e) {
      console.warn('[NMP] Pexels cache write failed', e);
      try {
        if (m.fs.existsSync(tmp)) m.fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  })();
};

// ---------- Download with progress, timeout and one retry on 429/503 ----------

export const downloadVideo = async (
  file: PexelsVideoFile,
  onProgress?: (p: number) => void,
  attempt = 0
): Promise<Blob> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(file.link, { signal: controller.signal });
    if (res.status === 429 || res.status === 503) {
      if (attempt === 0) {
        const ra = Number(res.headers.get('retry-after') || 0);
        const waitMs = Math.min(ra || 5, 60) * 1000;
        await new Promise(r => setTimeout(r, waitMs));
        return downloadVideo(file, onProgress, attempt + 1);
      }
      throw new PexelsApiError(String(res.status), `HTTP ${res.status}`);
    }
    if (!res.ok) throw new PexelsApiError(String(res.status), `HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length') || 0);
    const reader = res.body?.getReader();
    if (!reader) {
      const blob = await res.blob();
      if (blob.size < MIN_CLIP_SIZE) throw new PexelsApiError('invalid', 'File too small — download corrupted');
      onProgress?.(1);
      return blob;
    }

    const chunks: BlobPart[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        if (total > 0) onProgress?.(Math.min(1, received / total));
      }
    }
    const blob = new Blob(chunks, { type: file.file_type || 'video/mp4' });
    if (blob.size < MIN_CLIP_SIZE) throw new PexelsApiError('invalid', 'File too small — download corrupted');
    onProgress?.(1);
    return blob;
  } catch (e: any) {
    if (e instanceof PexelsApiError) throw e;
    if (e?.name === 'AbortError') throw new PexelsApiError('timeout', 'Download timed out');
    throw new PexelsApiError('network', e?.message || 'Network error');
  } finally {
    clearTimeout(timeout);
  }
};

// ---------- Public: ensure a playable Blob, using the cache ----------

const inFlight = new Map<string, Promise<Blob>>();

export const ensureClipBlob = (file: PexelsVideoFile, onProgress?: (p: number) => void): Promise<Blob> => {
  const hash = hashLink(file.link);
  const existing = inFlight.get(hash);
  if (existing) return existing;
  const p = (async () => {
    const cached = await readCacheFile(hash);
    if (cached) {
      onProgress?.(1);
      return cached;
    }
    const blob = await downloadVideo(file, onProgress);
    writeCacheFile(hash, blob);
    return blob;
  })().finally(() => {
    inFlight.delete(hash);
  });
  inFlight.set(hash, p);
  return p;
};
