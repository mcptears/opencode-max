import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Account } from '../api/client';

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);

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
      <div className="card">
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
    </div>
  );
}
