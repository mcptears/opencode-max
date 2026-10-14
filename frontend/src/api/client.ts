// API client for the Hadi Go backend.
const BASE = '';

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(t.slice(0, 300) || `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export const api = {
  get: <T>(p: string) => req<T>(p),
  post: <T>(p: string, body?: unknown) =>
    req<T>(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(p: string, body?: unknown) =>
    req<T>(p, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(p: string, body?: unknown) =>
    req<T>(p, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(p: string) => req<T>(p, { method: 'DELETE' }),
};

export interface Account {
  id: string;
  name: string;
  provider: string;
  priority: number;
  useProxy?: boolean;
  // Effective proxy mode: "off" direct, "pool" round-robin through the
  // whole proxy pool, "single" pinned to proxyUrl. Absent = legacy.
  proxyMode?: string;
  // Pinned proxy URL in REDACTED form (user:***@host) when mode is single.
  proxyUrl?: string;
  cooldownPeriod?: number;
  baseUrl?: string;
  quotaLimit?: number;
  state?: 'active' | 'cooling_down' | 'invalid';
  cooldownEndsInMs?: number;
  usage5h?: number;
  avgLatencyMs?: number;
  inflight?: number;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  enabled: boolean;
  protocol?: 'openai' | 'qwen-web' | 'deepseek-web' | 'zai-web';
}

export interface ProxyInfo {
  url: string;
  healthy: boolean;
  lastCheck?: number;
  latencyMs?: number;
}

// Display-side redaction: never show proxy passwords in the UI.
export function redactProxy(url: string): string {
  try {
    const u = new URL(url.includes('://') ? url : `http://${url}`);
    if (u.username || u.password) return `${u.protocol}//***@${u.host}`;
    return url;
  } catch {
    const at = url.indexOf('@');
    return at >= 0 ? `***@${url.slice(at + 1)}` : url;
  }
}

// Effective proxy mode for an account: explicit proxyMode wins, legacy
// accounts follow useProxy (false = off, anything else = pool).
export function proxyModeOf(a: Account): 'off' | 'pool' | 'single' {
  if (a.proxyMode === 'off' || a.proxyMode === 'pool' || a.proxyMode === 'single') return a.proxyMode;
  return a.useProxy === false ? 'off' : 'pool';
}
