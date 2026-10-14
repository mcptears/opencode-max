import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface LogEntry {
  time: string;
  kind: string;
  message: string;
  status?: number;
  latencyMs?: number;
}

type Filter = 'all' | 'requests' | 'events';

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = () => api.get<LogEntry[]>('/api/logs').then(setLogs).catch(() => {});
  useEffect(() => {
    load();
    if (!autoRefresh) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [autoRefresh]);

  const clear = async () => {
    if (!confirm('Clear the log feed? Request history behind the graphs is kept.')) return;
    await api.post('/api/logs/clear');
    load();
  };

  const shown = logs.filter((l) => {
    if (filter === 'requests') return l.kind === 'request';
    if (filter === 'events') return l.kind !== 'request';
    return true;
  });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Logs</h1>
          <p className="page-sub">Model requests and system events</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost btn-sm" onClick={clear}>Clear logs</button>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <div className="seg">
            {(['all', 'requests', 'events'] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'requests' ? 'Requests' : 'Events'}
              </button>
            ))}
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh
          </label>
        </div>
        {shown.length === 0 ? (
          <div className="empty"><span className="empty-ic">📝</span>No log entries yet.</div>
        ) : (
          shown.map((l, i) => (
            <div className="log-row" key={i}>
              <span className="log-time">{l.time}</span>
              <span className="log-kind">
                {l.status !== undefined ? (
                  <span className={`badge ${l.status < 400 ? 'badge-active' : 'badge-invalid'} badge-no-dot`}>{l.status}</span>
                ) : (
                  <span className="badge badge-neutral badge-no-dot">{l.kind}</span>
                )}
              </span>
              <span className="log-msg">{l.message}</span>
              {l.latencyMs !== undefined && (
                <span style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 12, whiteSpace: 'nowrap' }}>{l.latencyMs}ms</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
