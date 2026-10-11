export default function Setup() {
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
    </div>
  );
}
