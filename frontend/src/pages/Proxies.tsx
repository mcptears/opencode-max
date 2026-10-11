import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ProxyInfo } from '../api/client';

export default function Proxies() {
  const [proxies, setProxies] = useState<ProxyInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);

  const load = () => api.get<ProxyInfo[]>('/api/proxies').then(setProxies).catch(() => {});
  useEffect(() => { load(); }, []);

  const toggle = (url: string) => {
    const s = new Set(selected);
    s.has(url) ? s.delete(url) : s.add(url);
    setSelected(s);
  };

  const checkHealth = async () => {
    setChecking(true);
    try {
      await api.post('/api/proxies/check', { urls: selected.size ? [...selected] : undefined });
    } catch { /* ignore */ }
    setChecking(false);
    load();
  };

  return (
    <div>
      <h1 className="page-title">Proxies</h1>
      <p className="page-sub">IP rotation pool</p>
      <div className="card">
        <button className="btn btn-primary" onClick={checkHealth} disabled={checking}>
          {checking ? 'Checking…' : 'Check health'}
        </button>
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th></th><th>URL</th><th>Status</th><th>Latency</th></tr></thead>
            <tbody>
              {proxies.map((p) => (
                <tr key={p.url}>
                  <td><input type="checkbox" checked={selected.has(p.url)} onChange={() => toggle(p.url)} /></td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.url}</td>
                  <td><span className={`badge ${p.healthy ? 'badge-active' : 'badge-invalid'}`}>{p.healthy ? 'healthy' : 'down'}</span></td>
                  <td>{p.latencyMs ? `${p.latencyMs}ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
