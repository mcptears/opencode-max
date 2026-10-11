import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface LogEntry {
  time: string;
  kind: string;
  message: string;
  status?: number;
}

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const load = () => api.get<LogEntry[]>('/api/logs').then(setLogs).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const clear = async () => {
    await api.post('/api/logs/clear');
    load();
  };

  return (
    <div>
      <h1 className="page-title">Logs</h1>
      <p className="page-sub">Model requests and system events</p>
      <div className="card">
        <button className="btn btn-ghost btn-sm" onClick={clear}>Clear logs</button>
        <div style={{ marginTop: 12 }}>
          {logs.map((l, i) => (
            <div key={i} className="log-row">
              <span className="log-time">{l.time}</span>
              <span className={l.status ? (l.status < 300 ? 'log-200' : l.status < 500 ? 'log-429' : 'log-500') : ''}>
                {l.status || l.kind}
              </span>
              <span>{l.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
