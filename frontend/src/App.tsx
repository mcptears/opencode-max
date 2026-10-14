import { useState } from 'react';
import Overview from './pages/Overview';
import Accounts from './pages/Accounts';
import Providers from './pages/Providers';
import Playground from './pages/Playground';
import Proxies from './pages/Proxies';
import Settings from './pages/Settings';
import Logs from './pages/Logs';
import Setup from './pages/Setup';

type Section = 'overview' | 'accounts' | 'providers' | 'playground' | 'proxies' | 'settings' | 'logs' | 'setup';

const NAV: { id: Section; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: '📊' },
  { id: 'accounts', label: 'Accounts', icon: '🔑' },
  { id: 'providers', label: 'Providers', icon: '🔌' },
  { id: 'playground', label: 'Playground', icon: '💬' },
  { id: 'proxies', label: 'Proxies', icon: '🌐' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
  { id: 'logs', label: 'Logs', icon: '📝' },
  { id: 'setup', label: 'Setup', icon: '🚀' },
];

export default function App() {
  const [section, setSection] = useState<Section>('overview');

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-mark">⚡</div>
          <div>
            <h1>Hadi</h1>
            <small>ZEN PROXY CONTROL</small>
          </div>
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-btn ${section === n.id ? 'active' : ''}`}
            onClick={() => setSection(n.id)}
          >
            <span>{n.icon}</span>
            <span className="lbl">{n.label}</span>
          </button>
        ))}
      </nav>
      <main className="main">
        {section === 'overview' && <Overview />}
        {section === 'accounts' && <Accounts />}
        {section === 'providers' && <Providers />}
        {section === 'playground' && <Playground />}
        {section === 'proxies' && <Proxies />}
        {section === 'settings' && <Settings />}
        {section === 'logs' && <Logs />}
        {section === 'setup' && <Setup />}
      </main>
    </div>
  );
}
