import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Provider } from '../api/client';

const PRESETS = [
  { id: 'qwen', label: 'Qwen (built-in)' },
  { id: 'deepseek', label: 'DeepSeek (built-in)' },
  { id: 'zai', label: 'Z.ai (built-in)' },
  { id: 'opencode-zen', label: 'OpenCode Zen' },
];

export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => api.get<Provider[]>('/api/providers').then(setProviders).catch(() => {});
  useEffect(() => { load(); }, []);

  const addPreset = async (presetId: string) => {
    await api.post(`/api/providers/preset/${presetId}`);
    setShowAdd(false);
    load();
  };

  const toggle = async (p: Provider) => {
    await api.put(`/api/providers/${p.id}`, { ...p, enabled: !p.enabled });
    load();
  };

  return (
    <div>
      <h1 className="page-title">Providers</h1>
      <p className="page-sub">Upstream providers and model routing</p>
      <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add provider</button>
      <div style={{ marginTop: 16 }} className="card-grid">
        {providers.map((p) => (
          <div key={p.id} className="card">
            <h3>{p.name}</h3>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>{p.baseUrl}</p>
            <p style={{ marginTop: 8 }}>
              <span className={`badge ${p.enabled ? 'badge-active' : 'badge-invalid'}`}>{p.enabled ? 'enabled' : 'disabled'}</span>{' '}
              {p.protocol && <span className="badge badge-cooling">{p.protocol}</span>}
            </p>
            <p style={{ marginTop: 8, fontSize: 13 }}>Models: {p.models.join(', ')}</p>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => toggle(p)}>
              {p.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>
        ))}
      </div>
      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add provider</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
              {PRESETS.map((pr) => (
                <button key={pr.id} className="btn btn-ghost" onClick={() => addPreset(pr.id)}>
                  {pr.label}
                </button>
              ))}
            </div>
            <button className="btn btn-ghost" style={{ marginTop: 16 }} onClick={() => setShowAdd(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
