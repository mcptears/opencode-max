import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ProxyInfo } from '../api/client';

export default function Proxies() {
  const [proxies, setProxies] = useState<ProxyInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newProxies, setNewProxies] = useState('');
  const [addError, setAddError] = useState('');

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

  const addProxies = async () => {
    const lines = newProxies.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { setAddError('Paste at least one proxy'); return; }
    setAdding(true); setAddError('');
    try {
      const existing = proxies.map((p) => p.url);
      const merged = [...existing];
      for (const l of lines) {
        if (!merged.includes(l)) merged.push(l);
      }
      await api.post('/api/proxies', { proxies: merged });
      setNewProxies('');
      load();
    } catch (e: any) {
      setAddError(e.message || 'failed to add proxies');
    }
    setAdding(false);
  };

  return (
    <div>
      <h1 className="page-title">Proxies</h1>
      <p className="page-sub">IP rotation pool</p>
      <div className="card">
        <h3>Add proxies</h3>
        <p style={{ marginTop: 8, color: 'var(--muted)', fontSize: 13 }}>
          One per line, in any of these formats: <code>user:pass@host:port</code>,{' '}
          <code>host:port</code>, <code>http://user:pass@host:port</code>,{' '}
          <code>socks5://user:pass@host:port</code>
        </p>
        <textarea
          value={newProxies}
          onChange={(e) => setNewProxies(e.target.value)}
          placeholder={'user:pass@104.207.60.60:3129\nuser:pass@209.50.183.249:3129'}
          rows={5}
          style={{
            width: '100%', marginTop: 8, padding: 10, borderRadius: 8,
            background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)',
            fontFamily: 'monospace', fontSize: 12, resize: 'vertical',
          }}
        />
        {addError && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{addError}</p>}
        <button className="btn btn-primary" onClick={addProxies} disabled={adding} style={{ marginTop: 10 }}>
          {adding ? 'Adding…' : 'Add proxies'}
        </button>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
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
