import React, { useState } from 'react';
import { Language } from '../types';
import { i18n } from '../lib/i18n';
import { X } from 'lucide-react';
import {
  LlmConfig,
  LlmProviderId,
  PROVIDER_PRESETS,
  llmListModels,
  testLlmConnection,
} from '../services/llmService';

interface Props {
  config: LlmConfig | null;
  lang: Language;
  onSave: (cfg: LlmConfig | null) => void;
  onClose: () => void;
}

const normBase = (s: string) => s.trim().replace(/\/+$/, '');

export const LlmSettingsModal: React.FC<Props> = ({ config, lang, onSave, onClose }) => {
  const t = i18n[lang] as any;
  const initial = config?.provider || 'ollama';

  const [provider, setProvider] = useState<LlmProviderId>(initial);
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl || PROVIDER_PRESETS[initial].baseUrl);
  const [apiKey, setApiKey] = useState(config?.apiKey || '');
  const [model, setModel] = useState(config?.model || PROVIDER_PRESETS[initial].defaultModel);
  const [models, setModels] = useState<string[]>([]);
  const [modelsMsg, setModelsMsg] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'done'; ok?: boolean; msg?: string }>({ state: 'idle' });

  const preset = PROVIDER_PRESETS[provider];

  const handleProviderChange = (p: LlmProviderId) => {
    setProvider(p);
    const pr = PROVIDER_PRESETS[p];
    setBaseUrl(pr.baseUrl);
    setModel(p === initial ? model : pr.defaultModel);
    setModels([]);
    setModelsMsg(null);
    setTest({ state: 'idle' });
  };

  const buildCfg = (): LlmConfig => ({
    provider,
    baseUrl: normBase(baseUrl),
    apiKey: apiKey.trim(),
    model: model.trim(),
  });

  const handleRefreshModels = async () => {
    setModelsLoading(true);
    setModelsMsg(null);
    try {
      const list = await llmListModels(buildCfg());
      setModels(list);
      if (list.length === 0) setModelsMsg(t.llmTestFail || 'Failed: {err}');
    } catch (e: any) {
      setModelsMsg(e?.message || 'Error');
    } finally {
      setModelsLoading(false);
    }
  };

  const handleTest = async () => {
    setTest({ state: 'busy' });
    const r = await testLlmConnection(buildCfg());
    let msg: string;
    if (r.ok && r.modelCount !== undefined) {
      msg = (t.llmTestOk || 'Connected — {n} models ({ms} ms)').replace('{n}', String(r.modelCount)).replace('{ms}', String(r.ms));
    } else if (r.ok) {
      msg = (t.llmTestPingOk || 'Connected: {ms} ms').replace('{ms}', String(r.ms));
    } else {
      msg = (t.llmTestFail || 'Failed: {err}').replace('{err}', r.error || 'unknown');
    }
    setTest({ state: 'done', ok: r.ok, msg });
  };

  const canSave = !!(normBase(baseUrl) && model.trim());

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-[var(--panel)] border border-[var(--border)] rounded-lg w-[440px] p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[12px] font-bold tracking-wider">{t.llmSettings || 'Neural Engine'}</h2>
          <button onClick={onClose} className="text-[var(--text-dim)] hover:text-white transition-colors">
            <X size={14} />
          </button>
        </div>

        <div>
          <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{t.llmProvider || 'Provider'}</label>
          <select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as LlmProviderId)}
            className="w-full bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none"
          >
            {(Object.keys(PROVIDER_PRESETS) as LlmProviderId[]).map((id) => (
              <option key={id} value={id}>{PROVIDER_PRESETS[id].label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{t.llmBaseUrl || 'Base URL'}</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={preset.baseUrl || 'http://127.0.0.1:11434/v1'}
            className="w-full bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none font-mono"
          />
        </div>

        <div>
          <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">
            {t.llmApiKey || 'API Key'} <span className="normal-case">— {t.llmKeyOptional || '(optional for local)'}</span>
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={preset.needsKey ? 'sk-…' : '—'}
            className="w-full bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none font-mono"
          />
        </div>

        <div>
          <label className="text-[9px] uppercase text-[var(--text-dim)] mb-1 block">{t.llmModel || 'Model'}</label>
          <div className="flex gap-1.5">
            <input
              list="nmp-models"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={preset.defaultModel || 'model-name'}
              className="flex-1 min-w-0 bg-black border border-[var(--border)] rounded-sm px-2 py-2 text-[11px] focus:outline-none font-mono"
            />
            {preset.listable && (
              <button
                onClick={handleRefreshModels}
                disabled={modelsLoading || !normBase(baseUrl)}
                className="px-2.5 py-2 text-[10px] border border-[var(--border)] rounded-sm bg-[#16181d] hover:bg-[#1d2027] transition-colors disabled:opacity-40"
              >
                {modelsLoading ? '…' : (t.llmRefreshModels || 'Refresh')}
              </button>
            )}
          </div>
          <datalist id="nmp-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {modelsMsg && <p className="text-[10px] text-red-400 font-mono mt-1">{modelsMsg}</p>}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleTest}
            disabled={test.state === 'busy' || !normBase(baseUrl)}
            className="px-3 py-2 text-[10px] border border-[var(--border)] rounded-sm bg-[#16181d] hover:bg-[#1d2027] transition-colors disabled:opacity-40"
          >
            {test.state === 'busy' ? (t.llmTesting || 'Testing…') : (t.llmTest || 'Test connection')}
          </button>
          {test.state === 'done' && test.msg && (
            <p className={`text-[10px] font-mono ${test.ok ? 'text-emerald-400' : 'text-red-400'}`}>{test.msg}</p>
          )}
        </div>

        <div className="flex items-center justify-between pt-1 border-t border-[var(--border)]">
          <button
            onClick={() => onSave(null)}
            className="px-3 py-2 text-[10px] text-[var(--text-dim)] hover:text-red-400 transition-colors"
          >
            {t.llmDisconnect || 'Disconnect'}
          </button>
          <button
            onClick={() => canSave && onSave(buildCfg())}
            disabled={!canSave}
            className="px-4 py-2 text-[10px] font-bold bg-[var(--accent)] text-black rounded-sm hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {t.llmSave || 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};
