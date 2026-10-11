import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface Stats {
  totalRequests: number;
  successRate: number;
  avgLatencyMs: number;
  activeAccounts: number;
  totalAccounts: number;
}

export default function Overview() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api.get<Stats>('/api/metrics/summary').then(setStats).catch(() => {});
  }, []);

  return (
    <div>
      <h1 className="page-title">Overview</h1>
      <p className="page-sub">Real-time proxy pool status and traffic</p>
      <div className="card-grid">
        <div className="card">
          <div className="stat-label">Total Requests</div>
          <div className="stat">{stats?.totalRequests ?? '—'}</div>
        </div>
        <div className="card">
          <div className="stat-label">Success Rate</div>
          <div className="stat">{stats ? `${(stats.successRate * 100).toFixed(1)}%` : '—'}</div>
        </div>
        <div className="card">
          <div className="stat-label">Avg Latency</div>
          <div className="stat">{stats ? `${stats.avgLatencyMs}ms` : '—'}</div>
        </div>
        <div className="card">
          <div className="stat-label">Active Accounts</div>
          <div className="stat">{stats ? `${stats.activeAccounts}/${stats.totalAccounts}` : '—'}</div>
        </div>
      </div>
    </div>
  );
}
