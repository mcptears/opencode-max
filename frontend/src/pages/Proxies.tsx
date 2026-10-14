import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ProxyInfo } from '../api/client';

// Display-side redaction: never show proxy passwords in the UI.
// "http://user:pass@host:3129" -> "http://user:***@host:3129"
function redactProxy(url: string): string {
  const at = url.lastIndexOf('@');
  if (at === -1) return url;
  const before = url.slice(0, at);
  const colon = before.lastIndexOf(':');
  if (colon === -1) return url;
  const schemeEnd = before.indexOf('://');
  if (schemeEnd !== -1 && colon <= schemeEnd + 2) return url; // no userinfo
  return before.slice(0, colon + 1) + '***' + url.slice(at);
}

export default function Proxies() {
  const [proxies, setProxies] = useState<ProxyInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [newProxies, setNewProxies] = useState('');
  const [addError, setAddError] = useState('');

  const load = () => api.get<ProxyInfo[]>('/api/proxies').then(setProxies).catch(() => {});
  useEffect(() => { load(); }, []);

  const healthy = proxies.filter((p) => p.healthy).length;

  const toggle = (url: string) => {
    const s = new Set(selected);
    if (s.has(url)) s.delete(url); else s.add(url);
    setSelected(s);
  };

  const toggleAll = () => {
    if (selected.size === proxies.length) setSelected(new Set());
    else setSelected(new Set(proxies.map((p) => p.url)));
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

  const removeSelected = async () => {
    if (!selected.size) return;
    if (!confirm(`Remove ${selected.size} selected prox${selected.size === 1 ? 'y' : 'ies'}?`)) return;
    setRemoving(true);
    try {
      for (const url of selected) {
        await api.del(`/api/proxies?proxy=${encodeURIComponent(url)}`);
      }
      setSelected(new Set());
      load();
    } catch { /* ignore */ }
    setRemoving(false);
  };

  const clearAll = async () => {
    if (!proxies.length) return;
    if (!confirm(`Remove all ${proxies.length} proxies from the pool?`)) return;
    setRemoving(true);
    try {
      await api.post('/api/proxies', { proxies: [] });
      setSelected(new Set());
      load();
    } catch { /* ignore */ }
    setRemoving(false);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Proxies</h1>
          <p className="page-sub">IP rotation pool — {healthy} of {proxies.length} healthy</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={checkHealth} disabled={checking}>
            {checking ? 'Checking…' : 'Check health'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 className="section-title">Add proxies</h3>
        <p className="section-sub">
          One per line, in any of these formats: <code>user:pass@host:port</code>,{' '}
          <code>host:port</code>, <code>http://user:pass@host:port</code>,{' '}
          <code>socks5://user:pass@host:port</code>
        </p>
        <textarea
          className="input mono"
          value={newProxies}
          onChange={(e) => setNewProxies(e.target.value)}
          placeholder={'user:pass@104.207.60.60:3129\nuser:pass@209.50.183.249:3129'}
          rows={5}
          style={{ fontSize: 12 }}
        />
        {addError && <p className="form-error">{addError}</p>}
        <button className="btn btn-primary" onClick={addProxies} disabled={adding} style={{ marginTop: 12 }}>
          {adding ? 'Adding…' : 'Add proxies'}
        </button>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={removeSelected} disabled={!selected.size || removing}>
            {removing ? 'Removing…' : `Remove selected (${selected.size})`}
          </button>
          <button className="btn btn-danger btn-sm" onClick={clearAll} disabled={!proxies.length || removing}>
            Clear all
          </button>
        </div>
        {proxies.length === 0 ? (
          <div className="empty"><span className="empty-ic">🌐</span>No proxies in the pool. Add some above — direct connections are used until then.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th><input type="checkbox" checked={proxies.length > 0 && selected.size === proxies.length} onChange={toggleAll} /></th>
                  <th>URL</th><th>Status</th><th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {proxies.map((p) => (
                  <tr key={p.url}>
                    <td><input type="checkbox" checked={selected.has(p.url)} onChange={() => toggle(p.url)} /></td>
                    <td className="mono" title="Password hidden">{redactProxy(p.url)}</td>
                    <td><span className={`badge ${p.healthy ? 'badge-active' : 'badge-invalid'}`}>{p.healthy ? 'healthy' : 'down'}</span></td>
                    <td>{p.latencyMs ? `${p.latencyMs}ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
