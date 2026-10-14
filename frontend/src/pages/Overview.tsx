import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ProxyInfo, Provider } from '../api/client';
import type { Section } from '../App';

interface Stats {
  totalRequests: number;
  successRate: number;
  avgLatencyMs: number;
  activeAccounts: number;
  totalAccounts: number;
}

interface LogEntry {
  time: string;
  kind: string;
  message: string;
  status?: number;
}

export default function Overview({ onNavigate }: { onNavigate: (s: Section) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [proxies, setProxies] = useState<ProxyInfo[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [tokenCount, setTokenCount] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    api.get<Stats>('/api/metrics/summary').then(setStats).catch(() => {});
    api.get<ProxyInfo[]>('/api/proxies').then(setProxies).catch(() => {});
    api.get<Provider[]>('/api/providers').then(setProviders).catch(() => {});
    api.get<{ count: number }>('/api/zai/tokens').then((t) => setTokenCount(t.count)).catch(() => {});
    api.get<LogEntry[]>('/api/logs').then((l) => setLogs(l.slice(0, 6))).catch(() => {});
  }, []);

  const healthy = proxies.filter((p) => p.healthy).length;
  const enabledProviders = providers.filter((p) => p.enabled).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">Real-time proxy pool status and traffic</p>
        </div>
      </div>

      <div className="card-grid">
        <div className="card stat-card">
          <div className="stat-ic">📊</div>
          <div>
            <div className="stat-label">Total Requests</div>
            <div className="stat">{stats?.totalRequests ?? '—'}</div>
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-ic green">✅</div>
          <div>
            <div className="stat-label">Success Rate</div>
            <div className="stat">{stats ? `${(stats.successRate * 100).toFixed(1)}%` : '—'}</div>
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-ic cyan">⚡</div>
          <div>
            <div className="stat-label">Avg Latency</div>
            <div className="stat">{stats ? `${stats.avgLatencyMs}ms` : '—'}</div>
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-ic amber">👥</div>
          <div>
            <div className="stat-label">Active Accounts</div>
            <div className="stat">{stats ? `${stats.activeAccounts}/${stats.totalAccounts}` : '—'}</div>
          </div>
        </div>
      </div>

      <div className="card-grid" style={{ marginTop: 16 }}>
        <div className="card card-hover stat-card" onClick={() => onNavigate('proxies')}>
          <div className="stat-ic cyan">🌐</div>
          <div>
            <div className="stat-label">Proxy Pool</div>
            <div className="stat">{healthy}<span style={{ fontSize: 15, color: 'var(--muted)' }}> / {proxies.length} healthy</span></div>
            <div className="stat-sub">Manage proxies →</div>
          </div>
        </div>
        <div className="card card-hover stat-card" onClick={() => onNavigate('accounts')}>
          <div className="stat-ic">🔑</div>
          <div>
            <div className="stat-label">Z.ai Tokens</div>
            <div className="stat">{tokenCount}<span style={{ fontSize: 15, color: 'var(--muted)' }}> in pool</span></div>
            <div className="stat-sub">Open collector →</div>
          </div>
        </div>
        <div className="card card-hover stat-card" onClick={() => onNavigate('providers')}>
          <div className="stat-ic green">🔌</div>
          <div>
            <div className="stat-label">Providers</div>
            <div className="stat">{enabledProviders}<span style={{ fontSize: 15, color: 'var(--muted)' }}> / {providers.length} enabled</span></div>
            <div className="stat-sub">Manage providers →</div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 className="section-title">Recent activity</h3>
          <button className="btn btn-ghost btn-sm" onClick={() => onNavigate('logs')}>View all logs →</button>
        </div>
        {logs.length === 0 ? (
          <div className="empty"><span className="empty-ic">📝</span>No activity yet.</div>
        ) : (
          logs.map((l, i) => (
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
            </div>
          ))
        )}
      </div>
    </div>
  );
}
