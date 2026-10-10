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

export interface DeepSeekWebOptions {
  /** Default DeepSeek web model id when the request model has no mapping. */
  defaultModel: string;
  /** opencode-max model name -> DeepSeek web model id. */
  modelMap?: Record<string, string>;
  /** Default DeepThink (reasoning) for requests without an explicit model marker. */
  thinkingEnabled?: boolean;
  /** Default web search for requests without an explicit model marker. */
  searchEnabled?: boolean;
}

export interface ZaiWebOptions {
  /** Default Z.ai web model id when the request model has no mapping. */
  defaultModel: string;
  /** opencode-max model name -> Z.ai web model id. */
  modelMap?: Record<string, string>;
  /** Default thinking for requests without an explicit model marker. */
  thinkingEnabled?: boolean;
  /** Default web search for requests without an explicit model marker. */
  searchEnabled?: boolean;
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
   * opencode-max; `deepseek-web` does the same for DeepSeek's; `zai-web`
   * does the same for Z.ai's (chat.z.ai).
   */
  protocol?: 'openai' | 'qwen-web' | 'deepseek-web' | 'zai-web';
  /** Qwen web options (only used when protocol is 'qwen-web'). */
  qwen?: QwenWebOptions;
  /** DeepSeek web options (only used when protocol is 'deepseek-web'). */
  deepseek?: DeepSeekWebOptions;
  /** Z.ai web options (only used when protocol is 'zai-web'). */
  zai?: ZaiWebOptions;
}

export const PROVIDERS_FILE = path.join(projectRoot(), 'providers.json');

/** One-click preset: native DeepSeek web provider (built into opencode-max). */
export const DEEPSEEK_PRESET: ProviderConfig = {
  id: 'deepseek',
  name: 'DeepSeek (built-in)',
  baseUrl: 'https://chat.deepseek.com',
  models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-expert'],
  enabled: true,
  protocol: 'deepseek-web',
  deepseek: {
    defaultModel: 'deepseek-chat',
    modelMap: {
      'deepseek-r1': 'deepseek-reasoner',
      'deepseek-think': 'deepseek-reasoner',
      'deepseek-pro': 'deepseek-expert',
    },
  },
};

/** One-click preset: native Z.ai web provider (built into opencode-max). */
export const ZAI_PRESET: ProviderConfig = {
  id: 'zai',
  name: 'Z.ai (built-in)',
  baseUrl: 'https://chat.z.ai',
  models: ['glm*'],
  enabled: true,
  protocol: 'zai-web',
  zai: {
    defaultModel: 'glm-5',
    modelMap: {
      'glm-4.7': 'glm-4.7',
      'glm-4.5': 'glm-4.5',
      'glm-5-flash': 'glm-5-flash',
      'glm-5.3': 'glm-5.3',
      'glm-5.2': 'glm-5.2',
    },
  },
};

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
  const protocol = r.protocol === 'qwen-web' || r.protocol === 'deepseek-web' || r.protocol === 'zai-web' ? r.protocol : 'openai';
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
  let deepseek: DeepSeekWebOptions | undefined;
  if (protocol === 'deepseek-web' && r.deepseek && typeof r.deepseek === 'object') {
    const q = r.deepseek as Record<string, unknown>;
    const modelMap: Record<string, string> = {};
    if (q.modelMap && typeof q.modelMap === 'object') {
      for (const [k, v] of Object.entries(q.modelMap as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) modelMap[k] = v.trim();
      }
    }
    deepseek = {
      defaultModel: typeof q.defaultModel === 'string' && q.defaultModel.trim() ? q.defaultModel.trim() : 'deepseek-chat',
      ...(Object.keys(modelMap).length > 0 ? { modelMap } : {}),
      ...(typeof q.thinkingEnabled === 'boolean' ? { thinkingEnabled: q.thinkingEnabled } : {}),
      ...(typeof q.searchEnabled === 'boolean' ? { searchEnabled: q.searchEnabled } : {}),
    };
  }
  let zai: ZaiWebOptions | undefined;
  if (protocol === 'zai-web' && r.zai && typeof r.zai === 'object') {
    const q = r.zai as Record<string, unknown>;
    const modelMap: Record<string, string> = {};
    if (q.modelMap && typeof q.modelMap === 'object') {
      for (const [k, v] of Object.entries(q.modelMap as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) modelMap[k] = v.trim();
      }
    }
    zai = {
      defaultModel: typeof q.defaultModel === 'string' && q.defaultModel.trim() ? q.defaultModel.trim() : 'glm-5',
      ...(Object.keys(modelMap).length > 0 ? { modelMap } : {}),
      ...(typeof q.thinkingEnabled === 'boolean' ? { thinkingEnabled: q.thinkingEnabled } : {}),
      ...(typeof q.searchEnabled === 'boolean' ? { searchEnabled: q.searchEnabled } : {}),
    };
  }
  return {
    id: r.id.trim(),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : r.id.trim(),
    baseUrl: (r.baseUrl as string).trim().replace(/\/+$/, ''),
    models: models.length > 0 ? models : ['*'],
    enabled: r.enabled !== false,
    ...(protocol === 'qwen-web' ? { protocol, qwen: qwen ?? { defaultModel: 'qwen3.7-plus' } } : {}),
    ...(protocol === 'deepseek-web' ? { protocol, deepseek: deepseek ?? { defaultModel: 'deepseek-chat' } } : {}),
    ...(protocol === 'zai-web' ? { protocol, zai: zai ?? { defaultModel: 'glm-5' } } : {}),
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
