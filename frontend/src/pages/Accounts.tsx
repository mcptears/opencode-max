import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Account } from '../api/client';
import ConnectAccount from '../components/ConnectAccount';

const CONNECTABLE = [
  { id: 'qwen', name: 'Qwen' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'zai', name: 'Z.ai' },
  { id: 'opencode-zen', name: 'OpenCode Zen' },
];

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [connectProvider, setConnectProvider] = useState<{ id: string; name: string } | null>(null);

  const load = () => api.get<Account[]>('/api/accounts').then(setAccounts).catch(() => {});
  useEffect(() => { load(); }, []);

  const reset = async (id: string) => {
    await api.post(`/api/accounts/${id}/reset`);
    load();
  };

  const remove = async (id: string) => {
    if (!confirm('Remove this account?')) return;
    await api.del(`/api/accounts/${id}`);
    load();
  };

  return (
    <div>
      <h1 className="page-title">Accounts</h1>
      <p className="page-sub">Connected provider accounts</p>
      <button className="btn btn-primary" onClick={() => setShowPicker(true)}>+ Connect account</button>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Provider</th><th>Priority</th><th>State</th><th>Proxy</th><th></th></tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{a.provider}</td>
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
                  <td>{a.useProxy === false ? 'direct' : 'proxy'}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => reset(a.id)}>Reset</button>{' '}
                    <button className="btn btn-danger btn-sm" onClick={() => remove(a.id)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showPicker && (
        <div className="modal-overlay" onClick={() => setShowPicker(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <h2>Choose provider</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
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
            <button className="btn btn-ghost" style={{ marginTop: 16, width: '100%' }} onClick={() => setShowPicker(false)}>Cancel</button>
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
    </div>
  );
}
