import { useEffect, useState } from 'react';
import { api } from '../api/client';
import CollectorDialog from '../components/CollectorDialog';

interface TokenStatus {
  count: number;
  collecting: boolean;
  collectLog: string;
}

const ENV_VARS = [
  { name: 'PORT', desc: 'server port (default 8080)' },
  { name: 'UPSTREAM_BASE', desc: 'OpenCode Zen base URL' },
  { name: 'ACCOUNTS_FILE', desc: 'accounts.json path' },
  { name: 'PROXIES_FILE', desc: 'proxies.json path' },
  { name: 'CLIENT_TOKENS', desc: 'comma-separated API tokens for /v1/*' },
];

export default function Setup() {
  const [tokens, setTokens] = useState<TokenStatus>({ count: 0, collecting: false, collectLog: '' });
  const [showCollector, setShowCollector] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadTokens = () =>
    api.get<TokenStatus>('/api/zai/tokens').then(setTokens).catch(() => {});

  useEffect(() => {
    loadTokens();
    const t = setInterval(loadTokens, 5000);
    return () => clearInterval(t);
  }, []);

  const endpoint = `${window.location.origin}/v1`;

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  const clear = async () => {
    if (!confirm('Clear all harvested device tokens?')) return;
    await api.del('/api/zai/tokens');
    loadTokens();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Setup</h1>
          <p className="page-sub">Connect Hadi to your tools</p>
        </div>
      </div>

      <div className="card">
        <h3 className="section-title">OpenAI-compatible endpoint</h3>
        <p className="section-sub">Point any OpenAI client at this base URL. Use a client token from Settings → Advanced if you set one.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <code style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '10px 12px', fontSize: 13.5, overflowX: 'auto' }}>{endpoint}</code>
          <button className="btn btn-ghost" onClick={copyEndpoint}>{copied ? 'Copied ✓' : 'Copy'}</button>
        </div>

        <h3 className="section-title" style={{ marginTop: 22 }}>Environment variables</h3>
        <p className="section-sub">Set before starting the server. Most settings are also editable on the Settings page.</p>
        <div>
          {ENV_VARS.map((v) => (
            <div key={v.name} style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
              <code style={{ minWidth: 150 }}>{v.name}</code>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>{v.desc}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h3 className="section-title">Z.ai device tokens</h3>
            <p className="section-sub">Z.ai needs a captcha token per request. Hadi harvests them automatically from a headless browser — no DevTools needed. Each token is single-use.</p>
            <p>
              <span className="badge badge-active badge-no-dot">{tokens.count} in pool</span>{' '}
              {tokens.collecting && <span className="badge badge-cooling">collecting…</span>}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={() => setShowCollector(true)}>Collector setup…</button>
            <button className="btn btn-ghost" onClick={clear} disabled={tokens.count === 0}>Clear</button>
          </div>
        </div>
        {tokens.collectLog && <div className="log-pre" style={{ marginTop: 14 }}>{tokens.collectLog}</div>}
      </div>

      <CollectorDialog open={showCollector} onClose={() => { setShowCollector(false); loadTokens(); }} />
    </div>
  );
}
