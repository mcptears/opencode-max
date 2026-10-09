import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { projectRoot } from './paths.js';

export interface QwenWebOptions {
  /** Default Qwen web model id when the request model has no mapping. */
  defaultModel: string;
  /** opencode-max model name -> Qwen web model id. */
  modelMap?: Record<string, string>;
}

export interface ProviderConfig {
  /** Stable id, e.g. "opencode-zen". Accounts reference it via their `provider` field. */
  id: string;
  name: string;
  /** OpenAI-compatible base URL, e.g. https://opencode.ai/zen/v1 */
  baseUrl: string;
  /** Glob patterns matched against the request model, in order. `*` = catch-all. */
  models: string[];
  enabled: boolean;
  /**
   * Upstream protocol. `openai` (default) forwards OpenAI-format requests
   * untouched; `qwen-web` speaks Qwen's private web API natively inside
   * opencode-max — no separate qwen2api deployment needed.
   */
  protocol?: 'openai' | 'qwen-web';
  /** Qwen web options (only used when protocol is 'qwen-web'). */
  qwen?: QwenWebOptions;
}

export const PROVIDERS_FILE = path.join(projectRoot(), 'providers.json');

/** One-click preset: native Qwen web provider (built into opencode-max). */
export const QWEN_PRESET: ProviderConfig = {
  id: 'qwen',
  name: 'Qwen (built-in)',
  baseUrl: 'https://chat.qwen.ai',
  models: ['qwen*'],
  enabled: true,
  protocol: 'qwen-web',
  qwen: {
    defaultModel: 'qwen3.7-plus',
    modelMap: {
      'qwen-max': 'qwen3.7-max',
      'qwen-plus': 'qwen3.7-plus',
      'qwen-coder': 'qwen3-coder-plus',
      'qwen-flash': 'qwen3.8-omni-flash',
    },
  },
};

function defaultProviders(): ProviderConfig[] {
  return [
    {
      id: 'opencode-zen',
      name: 'OpenCode Zen',
      baseUrl: CONFIG.upstreamBase,
      models: ['*'],
      enabled: true,
    },
  ];
}

function normalize(p: unknown): ProviderConfig | null {
  if (!p || typeof p !== 'object') return null;
  const r = p as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return null;
  if (typeof r.baseUrl !== 'string' || !r.baseUrl.trim()) return null;
  try {
    new URL(r.baseUrl as string);
  } catch {
    return null;
  }
  const models = Array.isArray(r.models)
    ? (r.models as unknown[]).filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    : [];
  const protocol = r.protocol === 'qwen-web' ? 'qwen-web' : 'openai';
  let qwen: QwenWebOptions | undefined;
  if (protocol === 'qwen-web' && r.qwen && typeof r.qwen === 'object') {
    const q = r.qwen as Record<string, unknown>;
    const modelMap: Record<string, string> = {};
    if (q.modelMap && typeof q.modelMap === 'object') {
      for (const [k, v] of Object.entries(q.modelMap as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) modelMap[k] = v.trim();
      }
    }
    qwen = {
      defaultModel: typeof q.defaultModel === 'string' && q.defaultModel.trim() ? q.defaultModel.trim() : 'qwen3.7-plus',
      ...(Object.keys(modelMap).length > 0 ? { modelMap } : {}),
    };
  }
  return {
    id: r.id.trim(),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : r.id.trim(),
    baseUrl: (r.baseUrl as string).trim().replace(/\/+$/, ''),
    models: models.length > 0 ? models : ['*'],
    enabled: r.enabled !== false,
    ...(protocol === 'qwen-web' ? { protocol, qwen: qwen ?? { defaultModel: 'qwen3.7-plus' } } : {}),
  };
}

export function loadProviders(): ProviderConfig[] {
  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8')) as unknown;
      const list = (Array.isArray(raw) ? raw : (raw as { providers?: unknown }).providers) as unknown[];
      if (Array.isArray(list)) {
        const providers = list.map(normalize).filter((p): p is ProviderConfig => p !== null);
        if (providers.length > 0) return providers;
      }
    }
  } catch {
    /* corrupted -> fall back to defaults */
  }
  return defaultProviders();
}

export function saveProviders(providers: ProviderConfig[]): void {
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify({ providers }, null, 2) + '\n', { mode: 0o600 });
}

/** `*` matches any run of characters (case-insensitive). */
export function globMatch(pattern: string, model: string): boolean {
  const rx = new RegExp(
    '^' + pattern.trim().split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    'i',
  );
  return rx.test(model);
}

/** First enabled provider whose models match — specific patterns beat a bare
 *  `*` catch-all regardless of file order, so `qwen*` wins over zen's `*`. */
export function matchProvider(providers: ProviderConfig[], model: string | undefined): ProviderConfig | null {
  if (!model) return null;
  const enabled = providers.filter((p) => p.enabled);
  const ordered = [
    ...enabled.filter((p) => !p.models.includes('*')),
    ...enabled.filter((p) => p.models.includes('*')),
  ];
  for (const p of ordered) {
    if (p.models.some((m) => globMatch(m, model))) return p;
  }
  return null;
}

/** The catch-all provider used when no model pattern matches. */
export function defaultProvider(providers: ProviderConfig[]): ProviderConfig | null {
  return providers.find((p) => p.enabled && p.models.includes('*')) ?? providers.find((p) => p.enabled) ?? null;
}
