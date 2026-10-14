import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Account, Provider } from '../api/client';

const PRESETS = [
  { id: 'qwen', label: 'Qwen', desc: 'chat.qwen.ai web API — sign in with your Qwen account.' },
  { id: 'deepseek', label: 'DeepSeek', desc: 'chat.deepseek.com web API — email + password sign-in.' },
  { id: 'zai', label: 'Z.ai', desc: 'chat.z.ai web API — JWT + harvested device tokens.' },
  { id: 'opencode-zen', label: 'OpenCode Zen', desc: 'opencode.ai/zen — API key, IP rotation pool.' },
];

const PROVIDER_ICON: Record<string, string> = {
  qwen: '🟣',
  deepseek: '🔵',
  zai: '⚡',
  'opencode-zen': '🌀',
};

export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});

  const load = () => {
    api.get<Provider[]>('/api/providers').then(setProviders).catch(() => {});
    api.get<Account[]>('/api/accounts').then(setAccounts).catch(() => {});
  };
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

  const remove = async (p: Provider) => {
    if (!confirm(`Remove provider "${p.name}"? Its accounts stay connected.`)) return;
    await api.del(`/api/providers/${p.id}`);
    load();
  };

  const test = async (p: Provider) => {
    setTesting(p.id);
    try {
      const r = await api.post<{ ok: boolean; models?: number; error?: string }>(`/api/providers/${p.id}/test`);
      setResults((s) => ({ ...s, [p.id]: r.ok ? `✓ Connected — ${r.models ?? 0} models` : `✗ ${r.error || 'failed'}` }));
    } catch (e: any) {
      setResults((s) => ({ ...s, [p.id]: `✗ ${e.message || 'failed'}` }));
    }
    setTesting(null);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Providers</h1>
          <p className="page-sub">Upstream providers and model routing</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add provider</button>
        </div>
      </div>

      {providers.length === 0 ? (
        <div className="card"><div className="empty"><span className="empty-ic">🔌</span>No providers yet. Add a built-in provider to get started.</div></div>
      ) : (
        <div className="card-grid">
          {providers.map((p) => {
            const count = accounts.filter((a) => a.provider === p.id).length;
            const result = results[p.id];
            return (
              <div key={p.id} className="card">
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div className="stat-ic" style={{ width: 44, height: 44, fontSize: 20 }}>{PROVIDER_ICON[p.id] || '🔌'}</div>
                  <div style={{ minWidth: 0 }}>
                    <h3 style={{ fontSize: 16 }}>{p.name}</h3>
                    <p style={{ color: 'var(--muted)', fontSize: 12.5, wordBreak: 'break-all' }}>{p.baseUrl}</p>
                  </div>
                </div>
                <p style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className={`badge ${p.enabled ? 'badge-active' : 'badge-invalid'}`}>{p.enabled ? 'enabled' : 'disabled'}</span>
                  {p.protocol && <span className="badge badge-neutral badge-no-dot">{p.protocol}</span>}
                  <span className="badge badge-neutral badge-no-dot">{count} account{count === 1 ? '' : 's'}</span>
                </p>
                <div style={{ marginTop: 12 }}>
                  <div className="stat-label" style={{ marginBottom: 6 }}>Models</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {p.models.map((m) => (
                      <code key={m}>{m}</code>
                    ))}
                  </div>
                </div>
                {result && <p style={{ marginTop: 12, fontSize: 13, color: result.startsWith('✓') ? 'var(--green)' : '#fca5a5' }}>{result}</p>}
                <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => test(p)} disabled={testing === p.id}>
                    {testing === p.id ? 'Testing…' : 'Test'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => toggle(p)}>
                    {p.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => remove(p)}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h2>Add provider</h2>
                <p>Built-in providers. Refreshing one updates its model list without touching your accounts.</p>
              </div>
              <button className="modal-close" onClick={() => setShowAdd(false)}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {PRESETS.map((pr) => (
                  <button key={pr.id} className="btn btn-ghost" style={{ justifyContent: 'flex-start', textAlign: 'left', padding: '12px 14px' }} onClick={() => addPreset(pr.id)}>
                    <span>
                      <span style={{ display: 'block', fontWeight: 700 }}>{pr.label}</span>
                      <span style={{ display: 'block', fontWeight: 400, fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'normal' }}>{pr.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setShowAdd(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
