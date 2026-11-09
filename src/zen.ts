/**
 * OpenCode Zen / Console gateway details shared by the proxy, provider
 * registry and admin validation paths.
 *
 * Zen is an OpenAI/Anthropic/Gemini-compatible gateway. Pay-as-you-go
 * (Console) and OpenCode Go are served from different base URLs:
 *
 *   Console: https://opencode.ai/inference
 *   Go:      https://opencode.ai/inference/go
 *
 * The legacy https://opencode.ai/zen/v1 prefix is obsolete and is migrated on
 * load so existing configs keep working.
 */

export const ZEN_USER_AGENT = 'opencode-max/1.0';

export const CONSOLE_BASE = 'https://opencode.ai/inference';
export const GO_BASE = 'https://opencode.ai/inference/go';
export const LEGACY_CONSOLE_BASE = 'https://opencode.ai/zen/v1';
export const LEGACY_GO_BASE = 'https://opencode.ai/zen/go/v1';

export type ZenPlan = 'console' | 'go';

/** Map user input to a known plan; null means "inherit the default". */
export function normalizePlan(value: unknown): ZenPlan | null {
  if (typeof value !== 'string') return null;
  switch (value.trim().toLowerCase()) {
    case 'go':
    case 'go-plus':
    case 'goplus':
    case 'go_plus':
    case 'teams':
    case 'go-teams':
      return 'go';
    case 'console':
    case 'payg':
    case 'pay-as-you-go':
    case 'pay_as_you_go':
    case 'balance':
      return 'console';
    default:
      return null;
  }
}

/** Canonicalize a gateway base URL; legacy Zen prefixes migrate. */
export function normalizeBase(base: string): string {
  const b = (base ?? '').trim().replace(/\/+$/, '');
  const lower = b.toLowerCase();
  if (lower === LEGACY_GO_BASE.toLowerCase() || lower === 'https://opencode.ai/zen/go') {
    return GO_BASE;
  }
  if (lower === LEGACY_CONSOLE_BASE.toLowerCase() || lower === 'https://opencode.ai/zen') {
    return CONSOLE_BASE;
  }
  return b;
}

/** True when base points at an OpenCode Zen/Console gateway. */
export function isGateway(base: string): boolean {
  const b = normalizeBase(base).toLowerCase();
  if (!b.startsWith('https://opencode.ai/')) return false;
  const rest = b.slice('https://opencode.ai'.length);
  return rest.startsWith('/inference') || rest.startsWith('/zen');
}

/** Infer the plan from a gateway base URL. */
export function planFromBase(base: string): ZenPlan {
  const b = normalizeBase(base).toLowerCase();
  return b.startsWith(GO_BASE.toLowerCase()) || b.startsWith('https://opencode.ai/zen/go') ? 'go' : 'console';
}

/** Canonical gateway root for a plan. */
export function baseForPlan(plan: ZenPlan): string {
  return plan === 'go' ? GO_BASE : CONSOLE_BASE;
}

/**
 * Build the upstream URL for a request path. For Zen gateways the API-family
 * prefix is inserted (OpenAI Chat/Responses, Anthropic Messages, or the shared
 * model catalog). Non-Zen bases are passed through unchanged.
 */
export function zenEndpoint(base: string, requestPath: string): string {
  const b = normalizeBase(base);
  const p = requestPath || '/';
  if (!isGateway(b)) return `${b}${p}`;
  const lower = b.toLowerCase();
  for (const suffix of ['/openai/v1', '/anthropic/v1', '/google/v1beta', '/v1']) {
    if (lower.endsWith(suffix)) return `${b}${p}`;
  }
  if (p === '/models' || p.startsWith('/models?')) return `${b}/v1/models`;
  if (p.startsWith('/messages')) return `${b}/anthropic/v1${p}`;
  if (p.startsWith('/responses')) return `${b}/openai/v1${p}`;
  return `${b}/openai/v1${p}`;
}

/**
 * Free-tier chat models are reserved for the official OpenCode client. Other
 * clients must use paid or Go models instead of trying to evade the
 * restriction.
 */
export function isFreeModel(model: string): boolean {
  const m = (model ?? '').trim().toLowerCase();
  if (!m) return false;
  return m.endsWith('-free') || m === 'big-pickle' || m.startsWith('big-pickle-');
}

/** First non-free model id, or null when the catalog only has free models. */
export function pickPaidModel(models: string[]): string | null {
  for (const raw of models) {
    const m = (raw ?? '').trim();
    if (m && !isFreeModel(m)) return m;
  }
  return null;
}

/** Parse Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number {
  const v = (value ?? '').trim();
  if (!v) return 0;
  if (/^\d+$/.test(v)) {
    const secs = Number(v);
    return secs > 0 ? secs * 1000 : 0;
  }
  const t = Date.parse(v);
  if (Number.isFinite(t)) {
    const d = t - now;
    return d > 0 ? d : 0;
  }
  return 0;
}

export interface ZenUsage {
  billingSource: string;
  /** USD billed for the request. */
  cost: number;
  /** USD list price before plan discounts. */
  listCost: number;
  /** Remaining Go allowance in dollars (0 when unreported). */
  allowance: number;
  inputTokens: number;
  outputTokens: number;
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

function usageFromObject(obj: unknown): ZenUsage | null {
  if (!obj || typeof obj !== 'object') return null;
  const usage = (obj as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const opencode = (usage as { opencode?: unknown }).opencode;
  if (!opencode || typeof opencode !== 'object') return null;
  const o = opencode as Record<string, unknown>;
  const tokens = (o.tokens ?? {}) as Record<string, unknown>;
  const cost = num(o.cost) || num((usage as Record<string, unknown>).cost);
  return {
    billingSource: typeof o.billing_source === 'string' ? o.billing_source : '',
    cost,
    listCost: num(o.list_cost),
    allowance: num(o.allowance),
    inputTokens: num(tokens.input),
    outputTokens: num(tokens.output),
  };
}

/** Extract Zen cost/allowance metadata from a parsed JSON response body. */
export function parseZenUsage(body: unknown): ZenUsage | null {
  return usageFromObject(body);
}

/** Extract Zen usage from a complete response body (JSON or SSE). */
export function parseZenUsageFromText(text: string): ZenUsage | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const u = parseZenUsage(JSON.parse(trimmed));
      if (u) return u;
    } catch {
      /* fall through to SSE scanning */
    }
  }
  let last: ZenUsage | null = null;
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const u = parseZenUsage(JSON.parse(payload));
      if (u) last = u;
    } catch {
      /* ignore malformed chunks */
    }
  }
  return last;
}
