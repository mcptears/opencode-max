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
  del: <T>(p: string) => req<T>(p, { method: 'DELETE' }),
};

export interface Account {
  id: string;
  name: string;
  provider: string;
  priority: number;
  cookies?: string;
  useProxy?: boolean;
  cooldownPeriod?: number;
  baseUrl?: string;
  quotaLimit?: number;
  state?: 'active' | 'cooling_down' | 'invalid';
  cooldownUntil?: number;
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
