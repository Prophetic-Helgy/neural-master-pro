/**
 * Multi-provider LLM service for the "Neural Engine" (Auto Master + AI diagnostics).
 * Modelled on pexelsService.ts: custom error class, raw fetch, AbortController
 * timeout, one retry on 429/503 honoring Retry-After.
 *
 * Transports: OpenAI-compatible chat/completions (OpenAI, Groq, Mistral,
 * OpenRouter, LM Studio, vLLM, Ollama /v1, custom), Anthropic native
 * /v1/messages, Google Gemini native :generateContent.
 *
 * NOTE: API keys live only in localStorage['nmp_llm_config'] and are never
 * logged.
 */
import { AudioSnapshot, Language, MasteringSettings, TrackMetadata } from '../types';
import type { PipelineMetrics } from '../lib/audioMeters';

export type LlmProviderId =
  | 'ollama' | 'lmstudio' | 'vllm' | 'openai' | 'anthropic'
  | 'gemini' | 'groq' | 'mistral' | 'openrouter' | 'custom';

export type LlmTransport = 'openai' | 'anthropic' | 'gemini';

export interface LlmConfig {
  provider: LlmProviderId;
  baseUrl: string; // no trailing slash
  apiKey: string;  // '' for local providers
  model: string;
}

export interface LlmProviderPreset {
  label: string;
  baseUrl: string;
  defaultModel: string;
  needsKey: boolean;
  transport: LlmTransport;
  listable: 'ollama' | 'openai' | null; // model-listing endpoint style
}

export const PROVIDER_PRESETS: Record<LlmProviderId, LlmProviderPreset> = {
  ollama:     { label: 'Ollama (local)',  baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3.1:8b',        needsKey: false, transport: 'openai',    listable: 'ollama' },
  lmstudio:   { label: 'LM Studio (local)', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: '',                    needsKey: false, transport: 'openai',    listable: 'openai' },
  vllm:       { label: 'vLLM (local)',    baseUrl: 'http://127.0.0.1:8000/v1',  defaultModel: '',                    needsKey: false, transport: 'openai',    listable: 'openai' },
  openai:     { label: 'OpenAI',          baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini',         needsKey: true,  transport: 'openai',    listable: 'openai' },
  anthropic:  { label: 'Anthropic',       baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5',   needsKey: true,  transport: 'anthropic', listable: null },
  gemini:     { label: 'Google Gemini',   baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.0-flash', needsKey: true, transport: 'gemini', listable: null },
  groq:       { label: 'Groq',            baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', needsKey: true, transport: 'openai', listable: 'openai' },
  mistral:    { label: 'Mistral',         baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', needsKey: true, transport: 'openai',  listable: 'openai' },
  openrouter: { label: 'OpenRouter',      baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini', needsKey: true, transport: 'openai', listable: 'openai' },
  custom:     { label: 'Custom (OpenAI-compatible)', baseUrl: '', defaultModel: '', needsKey: false, transport: 'openai', listable: 'openai' },
};

const CONFIG_KEY = 'nmp_llm_config';
const RETRY_AFTER_CAP_MS = 30000;

// ---------- Config persistence ----------

export const loadLlmConfig = (): LlmConfig | null => {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p.provider !== 'string' || typeof p.baseUrl !== 'string') return null;
    return {
      provider: p.provider as LlmProviderId,
      baseUrl: p.baseUrl,
      apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
      model: typeof p.model === 'string' ? p.model : '',
    };
  } catch {
    return null;
  }
};

export const saveLlmConfig = (cfg: LlmConfig | null): void => {
  try {
    if (cfg) localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CONFIG_KEY);
  } catch {
    /* ignore */
  }
};

// ---------- Error ----------

export class LlmError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}

// ---------- Core chat (timeout + one retry on 429/503) ----------

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LlmChatOptions {
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

const fetchWithRetry = async (url: string, init: RequestInit, timeoutMs: number, attempt = 0): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if ((res.status === 429 || res.status === 503) && attempt === 0) {
      const ra = Number(res.headers.get('retry-after') || 0);
      const waitMs = Math.min(Math.max(ra, 1) * 1000, RETRY_AFTER_CAP_MS);
      await new Promise(r => setTimeout(r, waitMs));
      return fetchWithRetry(url, init, timeoutMs, attempt + 1);
    }
    return res;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new LlmError('timeout', 'Request timed out');
    throw new LlmError('network', e?.message || 'Network error');
  } finally {
    clearTimeout(timer);
  }
};

const throwHttpError = async (res: Response): Promise<never> => {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 200);
  } catch {
    /* ignore */
  }
  const tail = detail ? ` — ${detail}` : '';
  if (res.status === 401 || res.status === 403) throw new LlmError('auth', `HTTP ${res.status} — check API key${tail}`);
  if (res.status === 429) throw new LlmError('rate_limited', `Rate limited${tail}`);
  throw new LlmError(String(res.status), `HTTP ${res.status}${tail}`);
};

export const llmChat = async (cfg: LlmConfig, messages: LlmMessage[], opts: LlmChatOptions = {}): Promise<string> => {
  const { timeoutMs = 60000, temperature = 0.2, maxTokens = 2048 } = opts;
  const preset = PROVIDER_PRESETS[cfg.provider] || PROVIDER_PRESETS.custom;
  const base = (cfg.baseUrl || preset.baseUrl).replace(/\/+$/, '');
  const model = cfg.model.trim();
  if (!base) throw new LlmError('not_configured', 'No base URL');
  if (!model) throw new LlmError('not_configured', 'No model selected');

  if (preset.transport === 'openai') {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const res = await fetchWithRetry(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    }, timeoutMs);
    if (!res.ok) await throwHttpError(res);
    const json = await res.json();
    const text: unknown = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text) throw new LlmError('parse', 'Unexpected response shape');
    return text;
  }

  if (preset.transport === 'anthropic') {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    };
    const system = messages.find(m => m.role === 'system')?.content || '';
    const rest = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
    const res = await fetchWithRetry(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, system, messages: rest, temperature, max_tokens: maxTokens }),
    }, timeoutMs);
    if (!res.ok) await throwHttpError(res);
    const json = await res.json();
    const text = Array.isArray(json?.content) ? json.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
    if (!text) throw new LlmError('parse', 'Unexpected response shape');
    return text;
  }

  // Gemini native
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey };
  const system = messages.find(m => m.role === 'system')?.content || '';
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body: any = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetchWithRetry(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!res.ok) await throwHttpError(res);
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
  if (!text) throw new LlmError('parse', 'Empty response from model');
  return text;
};

// ---------- Model listing / connection test ----------

export const llmListModels = async (cfg: LlmConfig): Promise<string[]> => {
  const preset = PROVIDER_PRESETS[cfg.provider] || PROVIDER_PRESETS.custom;
  const base = (cfg.baseUrl || preset.baseUrl).replace(/\/+$/, '');
  if (!base) throw new LlmError('not_configured', 'No base URL');
  if (!preset.listable) throw new LlmError('unsupported', 'Model listing not supported for this provider');

  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  if (preset.listable === 'ollama') {
    const origin = base.replace(/\/v1$/, '');
    const res = await fetchWithRetry(`${origin}/api/tags`, { method: 'GET', headers }, 10000);
    if (!res.ok) await throwHttpError(res);
    const json = await res.json();
    return Array.isArray(json?.models)
      ? json.models.map((m: any) => (typeof m?.name === 'string' ? m.name : '')).filter(Boolean)
      : [];
  }

  const res = await fetchWithRetry(`${base}/models`, { method: 'GET', headers }, 10000);
  if (!res.ok) await throwHttpError(res);
  const json = await res.json();
  return Array.isArray(json?.data)
    ? json.data.map((m: any) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean)
    : [];
};

export interface LlmTestResult {
  ok: boolean;
  ms: number;
  modelCount?: number;
  error?: string;
}

export const testLlmConnection = async (cfg: LlmConfig): Promise<LlmTestResult> => {
  const start = Date.now();
  const preset = PROVIDER_PRESETS[cfg.provider] || PROVIDER_PRESETS.custom;
  const ms = () => Date.now() - start;
  try {
    if (preset.listable) {
      const models = await llmListModels(cfg);
      return { ok: true, ms: ms(), modelCount: models.length };
    }
    await llmChat(cfg, [{ role: 'user', content: 'ping' }], { timeoutMs: 30000, temperature: 0, maxTokens: 1 });
    return { ok: true, ms: ms() };
  } catch (e: any) {
    const err = e instanceof LlmError ? (e.code === 'network' ? 'cannot reach endpoint' : `${e.code}: ${e.message}`) : (e?.message || 'unknown error');
    return { ok: false, ms: ms(), error: err };
  }
};

// ---------- Shared prompt helpers ----------

const round2 = (n: number): number => Math.round(n * 100) / 100;

const findLast = (logs: AudioSnapshot[], labels: string[]): AudioSnapshot | undefined =>
  [...logs].reverse().find(l => labels.some(x => (l.label || '').includes(x)));

const trimTimeline = (tl: AudioSnapshot['timeline']): { t: number; rms: number }[] | undefined => {
  if (!tl || tl.length === 0) return undefined;
  if (tl.length <= 32) return tl.map(p => ({ t: round2(p.t), rms: round2(p.rms) }));
  const out: { t: number; rms: number }[] = [];
  const step = tl.length / 32;
  for (let i = 0; i < 32; i++) {
    const p = tl[Math.floor(i * step)];
    out.push({ t: round2(p.t), rms: round2(p.rms) });
  }
  return out;
};

const snapshotToCompact = (s: AudioSnapshot) => ({
  label: s.label,
  bpm: s.bpm ?? null,
  levels: {
    peak: round2(s.levels.peak),
    rms: round2(s.levels.rms),
    lufs: round2(s.levels.lufs),
    crestFactor: round2(s.levels.crestFactor),
  },
  spectrum: {
    sub: round2(s.spectrum.sub),
    low: round2(s.spectrum.low),
    lowMid: round2(s.spectrum.lowMid),
    mid: round2(s.spectrum.mid),
    highMid: round2(s.spectrum.highMid),
    high: round2(s.spectrum.high),
  },
  stereo: { correlation: round2(s.stereo.correlation), width: round2(s.stereo.width) },
  truePeakDb: s.truePeakDb != null ? round2(s.truePeakDb) : null,
  lraLu: s.lra != null ? round2(s.lra) : null,
  dcOffsetDb: s.dcOffsetDb != null ? round2(s.dcOffsetDb) : null,
  timeline: trimTimeline(s.timeline),
});

/** Compact view of the full-track metrics (measureMetrics) for prompts. */
const metricsToCompact = (m: PipelineMetrics) => ({
  integratedLufs: round2(m.integratedLufs),
  truePeakDb: round2(m.truePeakDb),
  samplePeakDb: round2(m.samplePeakDb),
  lraLu: round2(m.lra),
  crestDb: round2(m.crestDb),
  correlation: round2(m.correlation),
  dcOffsetDb: round2(m.dcOffsetDb),
  tone: {
    sub: round2(m.tone.subRatio),
    bass: round2(m.tone.bassRatio),
    lowMid: round2(m.tone.lowMidRatio),
    mid: round2(m.tone.midRatio),
    harsh: round2(m.tone.harshRatio),
    high: round2(m.tone.highRatio),
    air: round2(m.tone.airRatio),
    centroidHz: Math.round(m.tone.centroid),
    harshPeakHz: Math.round(m.tone.harshPeakHz),
  },
});

// ---------- Feature 1: Auto Master (LLM-suggested settings) ----------

// Whitelist with ranges mirroring the DSP clamps in geminiService.ts
const NUM_RANGES: Array<[keyof MasteringSettings, number, number]> = [
  ['gain', -18, 18],
  ['lowShelf', -10, 10], ['midRange', -10, 10], ['highShelf', -10, 10],
  ['compression', -5, 5], ['limiter', -5, 0],
  ['saturation', 0, 10], ['exciterAmount', 0, 10],
  ['stereoWidth', -50, 50], ['fundamentalFreq', 40, 120], ['haasAmount', 0, 100],
  ['eq31', -10, 10], ['eq62', -10, 10], ['eq125', -10, 10], ['eq250', -10, 10], ['eq500', -10, 10],
  ['eq1k', -10, 10], ['eq2k', -10, 10], ['eq4k', -10, 10], ['eq8k', -10, 10], ['eq16k', -10, 10],
  ['autotune', 0, 10], ['reverb', 0, 10], ['distortion', 0, 10], ['delay', 0, 10], ['chorus', 0, 10],
  ['bass_autotune', 0, 10], ['bass_reverb', 0, 10], ['bass_distortion', 0, 10], ['bass_delay', 0, 10], ['bass_chorus', 0, 10],
  ['mid_autotune', 0, 10], ['mid_reverb', 0, 10], ['mid_distortion', 0, 10], ['mid_delay', 0, 10], ['mid_chorus', 0, 10],
  ['side_autotune', 0, 10], ['side_reverb', 0, 10], ['side_distortion', 0, 10], ['side_delay', 0, 10], ['side_chorus', 0, 10],
  ['exciterFreq', 1000, 12000],
];

const extractJson = (text: string): any => {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new LlmError('parse', 'No JSON object in model response');
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    throw new LlmError('parse', 'Invalid JSON in model response');
  }
};

const sanitizeSettings = (raw: any): Partial<MasteringSettings> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LlmError('parse', 'settings is not an object');
  }
  const out: Partial<MasteringSettings> = {};
  for (const [field, lo, hi] of NUM_RANGES) {
    const v = (raw as any)[field];
    if (typeof v === 'number' && Number.isFinite(v)) {
      (out as any)[field] = round2(Math.max(lo, Math.min(hi, v)));
    }
  }
  if (typeof raw.dithering === 'boolean') out.dithering = raw.dithering;
  if (Object.keys(out).length < 3) {
    throw new LlmError('parse', 'Too few valid settings in model response');
  }
  return out;
};

const AUTO_MASTER_SYSTEM = `You are a professional music mastering engineer with 20 years of experience.
You receive measured audio data: an "original" snapshot (the source track) and a "reference" snapshot (the commercial release the user wants to match), plus the current mastering chain settings.
Analyze the differences and suggest adjustments to the mastering chain.
Respond with ONLY a valid JSON object — no markdown, no commentary — in this exact shape:
{ "settings": { "<field>": <number> }, "explanation": "<one or two short sentences>" }
Allowed fields and ranges (values in dB unless noted):
gain [-18,18]; lowShelf, midRange, highShelf, eq31, eq62, eq125, eq250, eq500, eq1k, eq2k, eq4k, eq8k, eq16k [-10,10];
compression [-5,5]; limiter [-5,0]; saturation, exciterAmount, autotune, reverb, distortion, delay, chorus (and the same fields with bass_/mid_/side_ prefixes) [0,10];
stereoWidth [-50,50]; fundamentalFreq [40,120] Hz; haasAmount [0,100] ms; exciterFreq [1000,12000] Hz; dithering (boolean).
Suggest only the fields that actually need changing. Prefer small, musical adjustments.`;

export interface LlmAutoMasterResult {
  settings: Partial<MasteringSettings>;
  explanation: string;
}

export const llmAutoMaster = async (
  cfg: LlmConfig,
  metadata: TrackMetadata,
  logs: AudioSnapshot[],
  current: MasteringSettings,
  trackMetrics?: PipelineMetrics | null
): Promise<LlmAutoMasterResult> => {
  const original = findLast(logs, ['Original', 'Оригинал']);
  const reference = findLast(logs, ['Reference', 'Референс']);
  if (!original && !reference) throw new LlmError('not_configured', 'No analyzed snapshots available');

  const data = {
    original: original ? snapshotToCompact(original) : null,
    reference: reference ? snapshotToCompact(reference) : null,
    trackMetrics: trackMetrics ? metricsToCompact(trackMetrics) : null,
    track: { title: metadata.title, artist: metadata.artist, genre: metadata.genre, bpm: metadata.bpm ?? null },
    currentSettings: current,
  };
  const user = `Measured data (dB scales as reported by the analyzer):\n${JSON.stringify(data)}\n\nReturn the JSON object now.`;

  const text = await llmChat(
    cfg,
    [{ role: 'system', content: AUTO_MASTER_SYSTEM }, { role: 'user', content: user }],
    { timeoutMs: 90000, temperature: 0.2, maxTokens: 2048 }
  );
  const parsed = extractJson(text);
  const settings = sanitizeSettings(parsed?.settings ?? parsed);
  const explanation = typeof parsed?.explanation === 'string' ? parsed.explanation.slice(0, 300) : '';
  return { settings, explanation };
};

// ---------- Feature 2: AI diagnostics report ----------

const LANG_NAMES: Record<Language, string> = {
  en: 'English', ru: 'Russian', zh: 'Chinese (Simplified)', fr: 'French',
  es: 'Spanish', ar: 'Arabic', ja: 'Japanese', ko: 'Korean', it: 'Italian',
};

export const llmAiReport = async (
  cfg: LlmConfig,
  logs: AudioSnapshot[],
  lang: Language,
  trackMetrics?: PipelineMetrics | null
): Promise<string> => {
  if (!logs || logs.length === 0) throw new LlmError('not_configured', 'No analyzed snapshots available');
  const snaps = [...logs].reverse().slice(0, 6).map(snapshotToCompact);
  const system = `You are a professional audio mastering engineer. Analyze the measured audio snapshots and write a concise diagnostic report in ${LANG_NAMES[lang]}.
Structure with these exact section headers: LOUDNESS, SPECTRUM, STEREO & PHASE, DYNAMICS, RECOMMENDATIONS.
Be specific: quote measured values, name concrete problems (mud around 200-400 Hz, harshness above 6 kHz, negative phase correlation, low crest factor, DC offset above -60 dB, true peak above -1 dBTP), and give 3-6 prioritized, actionable recommendations.
Max ~250 words. Plain text only, no markdown tables.`;
  const trackLine = trackMetrics
    ? `Full-track metrics (integrated, measured over the whole file):\n${JSON.stringify(metricsToCompact(trackMetrics))}\n\n`
    : '';
  const user = `${trackLine}Audio snapshots (newest last), dB scales as reported by the analyzer:\n${JSON.stringify(snaps)}\n\nWrite the report now.`;
  const text = await llmChat(
    cfg,
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { timeoutMs: 120000, temperature: 0.4, maxTokens: 4096 }
  );
  return text.trim();
};
