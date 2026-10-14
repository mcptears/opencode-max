import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Account } from '../api/client';
import ConnectAccount from '../components/ConnectAccount';
import CollectorDialog from '../components/CollectorDialog';
import EditAccountModal from '../components/EditAccountModal';

const CONNECTABLE = [
  { id: 'qwen', name: 'Qwen' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'zai', name: 'Z.ai' },
  { id: 'opencode-zen', name: 'OpenCode Zen' },
];

interface TokenStatus {
  count: number;
  collecting: boolean;
  collectLog: string;
}

const PROVIDER_BADGE: Record<string, string> = {
  zai: 'badge-purple',
  qwen: 'badge-cyan',
  deepseek: 'badge-neutral',
  'opencode-zen': 'badge-neutral',
};

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [connectProvider, setConnectProvider] = useState<{ id: string; name: string } | null>(null);
  const [tokens, setTokens] = useState<TokenStatus>({ count: 0, collecting: false, collectLog: '' });
  const [showCollector, setShowCollector] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = () => api.get<Account[]>('/api/accounts').then(setAccounts).catch(() => {});
  const loadTokens = () => api.get<TokenStatus>('/api/zai/tokens').then(setTokens).catch(() => {});
  useEffect(() => {
    load();
    loadTokens();
    const t = setInterval(loadTokens, 5000);
    return () => clearInterval(t);
  }, []);

  const hasZai = accounts.some((a) => a.provider === 'zai');

  const reset = async (id: string) => {
    await api.post(`/api/accounts/${id}/reset`);
    load();
  };

  const remove = async (id: string) => {
    if (!confirm('Remove this account?')) return;
    await api.del(`/api/accounts/${id}`);
    load();
  };

  const toggleProxy = async (a: Account) => {
    setToggling(a.id);
    try {
      await api.patch(`/api/accounts/${a.id}`, { useProxy: !(a.useProxy !== false) });
    } catch { /* ignore */ }
    setToggling(null);
    load();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Accounts</h1>
          <p className="page-sub">Connected provider accounts</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setShowPicker(true)}>+ Connect account</button>
        </div>
      </div>

      {hasZai && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h3 className="section-title">Z.ai device tokens</h3>
              <p className="section-sub">Z.ai needs a captcha token per chat request. Hadi harvests them automatically — each token is single-use.</p>
              <p>
                <span className="badge badge-active badge-no-dot">{tokens.count} in pool</span>{' '}
                {tokens.collecting && <span className="badge badge-cooling">collecting…</span>}
              </p>
            </div>
            <button className="btn btn-primary" onClick={() => setShowCollector(true)}>Collector setup…</button>
          </div>
        </div>
      )}

      <CollectorDialog open={showCollector} onClose={() => { setShowCollector(false); loadTokens(); }} />

      <div className="card">
        {accounts.length === 0 ? (
          <div className="empty"><span className="empty-ic">🔑</span>No accounts connected yet. Add one to start routing.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Provider</th><th>Priority</th><th>State</th><th>Proxy</th><th>5h usage</th><th>Latency</th><th></th></tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.name}</strong><div style={{ color: 'var(--faint)', fontSize: 12 }}>{a.id}</div></td>
                    <td><span className={`badge badge-no-dot ${PROVIDER_BADGE[a.provider] || 'badge-neutral'}`}>{a.provider}</span></td>
                    <td>{a.priority}</td>
                    <td>
                      <span
                        className={`badge badge-${a.state === 'active' ? 'active' : a.state === 'cooling_down' ? 'cooling' : 'invalid'}`}
                        onClick={() => a.state !== 'active' && reset(a.id)}
                        title={a.state !== 'active' ? 'Click to reset' : ''}
                      >
                        {a.state || 'active'}
                      </span>
                    </td>
                    <td>
                      <label className="toggle" title={a.useProxy === false ? 'Direct connection' : 'Routed through proxy pool'}>
                        <input
                          type="checkbox"
                          checked={a.useProxy !== false}
                          disabled={toggling === a.id}
                          onChange={() => toggleProxy(a)}
                        />
                        <span className="track" />
                      </label>
                    </td>
                    <td>{a.usage5h ?? '—'}{a.quotaLimit ? ` / ${a.quotaLimit}` : ''}</td>
                    <td>{a.avgLatencyMs ? `${Math.round(a.avgLatencyMs)}ms` : '—'}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditing(a)}>Edit</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => reset(a.id)}>Reset</button>
                        <button className="btn btn-danger btn-sm" onClick={() => remove(a.id)}>Remove</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showPicker && (
        <div className="modal-overlay" onClick={() => setShowPicker(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div><h2>Choose provider</h2></div>
              <button className="modal-close" onClick={() => setShowPicker(false)}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {CONNECTABLE.map((p) => (
                  <button
                    key={p.id}
                    className="btn btn-ghost"
                    onClick={() => { setShowPicker(false); setConnectProvider(p); }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setShowPicker(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {connectProvider && (
        <ConnectAccount
          providerId={connectProvider.id}
          providerName={connectProvider.name}
          onClose={() => setConnectProvider(null)}
          onDone={load}
        />
      )}

      {editing && (
        <EditAccountModal account={editing} onClose={() => setEditing(null)} onDone={load} />
      )}
    </div>
  );
}
