import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface TokenStatus {
  count: number;
  collecting: boolean;
  collectLog: string;
}

export default function Setup() {
  const [tokens, setTokens] = useState<TokenStatus>({ count: 0, collecting: false, collectLog: '' });

  const loadTokens = () =>
    api.get<TokenStatus>('/api/zai/tokens').then(setTokens).catch(() => {});

  useEffect(() => {
    loadTokens();
    const t = setInterval(loadTokens, 5000);
    return () => clearInterval(t);
  }, []);

  const collect = async () => {
    await api.post('/api/zai/tokens/collect?count=20');
    loadTokens();
  };

  const clear = async () => {
    if (!confirm('Clear all harvested device tokens?')) return;
    await api.del('/api/zai/tokens');
    loadTokens();
  };

  return (
    <div>
      <h1 className="page-title">Setup</h1>
      <p className="page-sub">Connect opencode-max to your tools</p>
      <div className="card">
        <h3>OpenAI-compatible endpoint</h3>
        <p style={{ marginTop: 8 }}>Point any OpenAI client at:</p>
        <code style={{ display: 'block', marginTop: 8, padding: 12, background: 'var(--bg3)', borderRadius: 8 }}>
          {window.location.origin}/v1
        </code>
        <h3 style={{ marginTop: 20 }}>Environment variables</h3>
        <ul style={{ marginTop: 8, paddingLeft: 20, color: 'var(--muted)' }}>
          <li><code>PORT</code> — server port (default 8080)</li>
          <li><code>UPSTREAM_BASE</code> — OpenCode Zen base URL</li>
          <li><code>ACCOUNTS_FILE</code> — accounts.json path</li>
          <li><code>PROXIES_FILE</code> — proxies.json path</li>
          <li><code>CLIENT_TOKENS</code> — comma-separated API tokens for /v1/*</li>
        </ul>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Z.ai device tokens</h3>
        <p style={{ marginTop: 8, color: 'var(--muted)' }}>
          Z.ai needs a captcha token per request. Hadi harvests them automatically
          from a headless browser — no DevTools needed. Each token is single-use.
        </p>
        <p style={{ marginTop: 8 }}>
          <span className="badge badge-active">{tokens.count} in pool</span>{' '}
          {tokens.collecting && <span className="badge badge-cooling">collecting…</span>}
        </p>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button className="btn" onClick={collect} disabled={tokens.collecting}>
            {tokens.collecting ? 'Collecting…' : 'Collect 20 tokens'}
          </button>
          <button className="btn btn-ghost" onClick={clear} disabled={tokens.count === 0}>
            Clear
          </button>
        </div>
        {tokens.collectLog && (
          <pre style={{
            marginTop: 12, padding: 12, background: 'var(--bg3)', borderRadius: 8,
            fontSize: 12, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap',
          }}>{tokens.collectLog}</pre>
        )}
      </div>
    </div>
  );
}
