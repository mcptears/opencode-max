import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ProxyAgent } from 'undici';
import { projectRoot } from './paths.js';

export type ProviderFormat = 'text' | 'geonode' | 'spys' | 'fpl' | 'proxynova';

export interface ProxyProvider {
  id: string;
  name: string;
  url: string;
  format: ProviderFormat;
  enabled: boolean;
}

const PROVIDERS_FILE = path.join(projectRoot(), 'proxy-providers.json');

/** Curated free proxy list sources. Users can add their own via the dashboard. */
export const DEFAULT_PROVIDERS: ProxyProvider[] = [
  {
    id: 'proxyscrape',
    name: 'ProxyScrape',
    url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
    format: 'text',
    enabled: true,
  },
  {
    id: 'thespeedx',
    name: 'TheSpeedX (GitHub)',
    url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    format: 'text',
    enabled: true,
  },
  {
    id: 'monosans',
    name: 'monosans (GitHub)',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    format: 'text',
    enabled: true,
  },
  {
    id: 'spysone',
    name: 'spys.one',
    url: 'https://spys.one/en/',
    format: 'spys',
    enabled: true,
  },
  {
    id: 'freeproxylist',
    name: 'free-proxy-list.net',
    url: 'https://free-proxy-list.net/',
    format: 'fpl',
    enabled: true,
  },
  {
    id: 'proxynova',
    name: 'ProxyNova',
    url: 'https://www.proxynova.com/proxy-server-list/',
    format: 'proxynova',
    enabled: true,
  },
  {
    id: 'geonode',
    name: 'GeoNode',
    url: 'https://proxylist.geonode.com/api/proxy-list?limit=120&page=1&sort_by=lastChecked&sort_type=desc',
    format: 'geonode',
    enabled: true,
  },
];

export function loadProviders(): ProxyProvider[] {
  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8')) as unknown;
      const list = (Array.isArray(raw) ? raw : (raw as { providers?: unknown }).providers) as ProxyProvider[];
      if (Array.isArray(list)) {
        return list.filter((p) => p && typeof p.id === 'string' && typeof p.url === 'string');
      }
    }
  } catch {
    /* corrupted -> fall back to defaults */
  }
  return DEFAULT_PROVIDERS.map((p) => ({ ...p }));
}

export function saveProviders(providers: ProxyProvider[]): void {
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify({ providers }, null, 2) + '\n', { mode: 0o600 });
}

/** Extract http://ip:port candidates from a provider response. */
export function parseProxies(text: string, format: ProviderFormat): string[] {
  if (format === 'spys') return parseSpysProxies(text);
  if (format === 'fpl') return parseFplProxies(text);
  if (format === 'proxynova') return parseProxynovaProxies(text);
  const out: string[] = [];
  if (format === 'geonode') {
    try {
      const data = JSON.parse(text) as { data?: { ip?: string; port?: string | number; protocols?: string[] }[] };
      for (const p of data.data ?? []) {
        if (typeof p.ip === 'string' && (typeof p.port === 'string' || typeof p.port === 'number')) {
          const protos = (p.protocols ?? []).map(String);
          if (protos.some((x) => x.toLowerCase().includes('http'))) {
            out.push(`http://${p.ip}:${p.port}`);
          }
        }
      }
    } catch {
      /* malformed -> no candidates */
    }
    return out;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:https?:\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\s*$/);
    if (m) out.push(`http://${m[1]}:${m[2]}`);
  }
  return out;
}

/**
 * spys.one: ports are XOR-obfuscated in JS (`document.write(":"+(A^B)+...)`)
 * with the variables defined in a packer'd script on the page.
 * We run just that script in an empty vm sandbox, read the numeric
 * variables, and decode each row's port.
 */
export function parseSpysProxies(html: string): string[] {
  const out: string[] = [];
  try {
    const packed = html.match(/<script type="text\/javascript">(eval\(function\(p,r,o,x,y,s\)[\s\S]*?)<\/script>/);
    if (!packed) return out;
    const sandbox: Record<string, unknown> = {};
    vm.createContext(sandbox);
    vm.runInContext(packed[1], sandbox, { timeout: 3000 });
    const vars = sandbox as Record<string, number>;

    const rowRe =
      /<font class=spy14>(\d{1,3}(?:\.\d{1,3}){3})<script>document\.write\(":"((?:\+\([A-Za-z0-9]+\^[A-Za-z0-9]+\))*)\)<\/script><\/font><\/td><td colspan=1><font class=spy1>([A-Za-z]+)<\/font>/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(html)) !== null) {
      const proto = m[3].toLowerCase();
      if (proto !== 'http' && proto !== 'https') continue;
      let port = '';
      for (const pair of m[2].matchAll(/\(([A-Za-z0-9]+)\^([A-Za-z0-9]+)\)/g)) {
        const a = vars[pair[1]];
        const b = vars[pair[2]];
        if (typeof a !== 'number' || typeof b !== 'number') {
          port = '';
          break;
        }
        port += String(a ^ b);
      }
      if (port) out.push(`http://${m[1]}:${port}`);
    }
  } catch {
    /* obfuscation changed -> no candidates rather than garbage */
  }
  return out;
}

/**
 * free-proxy-list.net: plain table rows `<tr><td>IP</td><td>PORT</td>...`.
 */
export function parseFplProxies(html: string): string[] {
  const out: string[] = [];
  const re = /<tr><td>(\d{1,3}(?:\.\d{1,3}){3})<\/td><td>(\d{2,5})<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(`http://${m[1]}:${m[2]}`);
  return out;
}

/**
 * proxynova.com: the IP is a pure-JS string expression inside
 * `<script>document.write(EXPR)</script>`; the port is plain text in the
 * next cell. We evaluate just the expression in an empty vm sandbox.
 */
export function parseProxynovaProxies(html: string): string[] {
  const out: string[] = [];
  const rowRe = /<tr data-proxy-id="\d+">(.*?)<\/tr>/gs;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html)) !== null) {
    const tds = [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((x) => x[1]);
    if (tds.length < 2) continue;
    const exprM = tds[0].match(/document\.write\((.*)\)<\/script>/s);
    const port = tds[1].replace(/<[^>]+>/g, '').trim();
    if (!exprM || !/^\d{2,5}$/.test(port)) continue;
    try {
      const sandbox: Record<string, unknown> = {};
      vm.createContext(sandbox);
      const ip = String(vm.runInContext(`(${exprM[1]})`, sandbox, { timeout: 1000 }));
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) out.push(`http://${ip}:${port}`);
    } catch {
      /* expression changed shape -> skip the row */
    }
  }
  return out;
}

export interface ScrapeResult {  startedAt: number;
  finishedAt: number;
  providers: { id: string; name: string; ok: boolean; found: number; error?: string }[];
  found: number;
  tested: number;
  working: string[];
}

export interface ScrapeProgress {
  phase: 'fetching' | 'testing';
  providersDone: number;
  providersTotal: number;
  currentProvider: string | null;
  providerResults: { id: string; name: string; ok: boolean; found: number; error?: string }[];
  found: number;
  tested: number;
  totalToTest: number;
  working: number;
}

/** Fetch one provider's list. Throws on network/parse failure. */
export async function fetchProvider(provider: ProxyProvider, timeoutMs = 20000): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Honour the environment's egress proxy (if any) for the list fetch itself.
    const envProxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.https_proxy ?? process.env.http_proxy;
    const res = await fetch(provider.url, {
      signal: controller.signal,
      headers: {
        'user-agent':
          provider.format === 'text' || provider.format === 'geonode'
            ? 'opencode-max/1.0'
            : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
      ...(envProxy ? { dispatcher: new ProxyAgent(envProxy) } : {}),
    } as RequestInit & { dispatcher?: unknown });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseProxies(await res.text(), provider.format);
  } finally {
    clearTimeout(timer);
  }
}

/** Test whether a proxy can reach upstream. */
export async function testProxy(proxy: string, target = 'https://opencode.ai/zen/v1/models', timeoutMs = 8000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      dispatcher: new ProxyAgent(proxy),
      signal: controller.signal,
    } as RequestInit & { dispatcher?: unknown });
    if (res.status >= 500) return false;
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scrape all enabled providers, test candidates with limited concurrency,
 * and return the working proxies. Caps tested candidates so a run stays sane.
 */
export async function scrapeAll(
  providers: ProxyProvider[],
  opts: { maxTest?: number; concurrency?: number } = {},
  onProgress?: (p: ScrapeProgress) => void,
): Promise<ScrapeResult> {
  const startedAt = Date.now();
  const maxTest = opts.maxTest ?? 120;
  const concurrency = opts.concurrency ?? 8;
  const perProvider: ScrapeResult['providers'] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  const enabled = providers.filter((x) => x.enabled);
  const emit = (partial: Partial<ScrapeProgress> & { phase: 'fetching' | 'testing' }): void => {
    try {
      onProgress?.({
        providersDone: perProvider.length,
        providersTotal: enabled.length,
        currentProvider: null,
        providerResults: [...perProvider],
        found: candidates.length,
        tested: 0,
        totalToTest: 0,
        working: 0,
        ...partial,
      });
    } catch { /* progress must never break the run */ }
  };

  for (const p of enabled) {
    emit({ phase: 'fetching', currentProvider: p.name });
    try {
      const found = await fetchProvider(p);
      let fresh = 0;
      for (const c of found) {
        if (!seen.has(c)) {
          seen.add(c);
          candidates.push(c);
          fresh += 1;
        }
      }
      perProvider.push({ id: p.id, name: p.name, ok: true, found: fresh });
    } catch (e) {
      perProvider.push({ id: p.id, name: p.name, ok: false, found: 0, error: String(e).slice(0, 120) });
    }
    emit({ phase: 'fetching' });
  }

  const toTest = candidates.slice(0, maxTest);
  const working: string[] = [];
  let tested = 0;
  emit({ phase: 'testing', tested: 0, totalToTest: toTest.length, working: 0, found: candidates.length });
  for (let i = 0; i < toTest.length; i += concurrency) {
    const batch = toTest.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((proxy) => testProxy(proxy)));
    results.forEach((ok, j) => {
      if (ok) working.push(batch[j]);
    });
    tested += batch.length;
    emit({ phase: 'testing', tested, totalToTest: toTest.length, working: working.length, found: candidates.length });
  }

  return {
    startedAt,
    finishedAt: Date.now(),
    providers: perProvider,
    found: candidates.length,
    tested: toTest.length,
    working,
  };
}
