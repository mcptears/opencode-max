import { useEffect, useState } from 'react';
import { api, proxyModeOf, redactProxy } from '../api/client';
import type { Account, Provider, ProxyInfo } from '../api/client';
import ConnectAccount from '../components/ConnectAccount';
import CollectorDialog from '../components/CollectorDialog';
import EditAccountModal from '../components/EditAccountModal';

const CONNECTABLE = [
  { id: 'qwen', name: 'Qwen' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'zai', name: 'Z.ai' },
  { id: 'opencode-zen', name: 'OpenCode Zen' },
];

const PROVIDER_ICON: Record<string, string> = {
  qwen: '🟣',
  deepseek: '🔵',
  zai: '⚡',
  'opencode-zen': '🌀',
};

interface TokenStatus {
  count: number;
  collecting: boolean;
  collectLog: string;
}

// Per-account proxy control: mode select (Direct / Pool round-robin /
// Single pinned proxy) + a proxy picker when Single is chosen.
// Like 9router's per-connection proxy binding: one account can go direct,
// stick to one proxy, or round-robin across the whole pool.
function ProxyControl({ account, proxies, onDone }: {
  account: Account;
  proxies: ProxyInfo[];
  onDone: () => void;
}) {
  // Local mode so picking "Single proxy" reveals the picker before the
  // save; it resyncs from the server value whenever the account reloads.
  const [mode, setMode] = useState<'off' | 'pool' | 'single'>(proxyModeOf(account));
  useEffect(() => { setMode(proxyModeOf(account)); }, [account.proxyMode, account.useProxy]);
  const [saving, setSaving] = useState(false);
  // Full URL of the pinned proxy, matched from the pool by redacted form.
  const matched = proxies.find((p) => redactProxy(p.url) === (account.proxyUrl || ''))?.url || '';
  const [proxyUrl, setProxyUrl] = useState(matched);
  useEffect(() => { setProxyUrl(matched); }, [matched]);

  const patch = async (body: { proxyMode: string; proxyUrl?: string }) => {
    setSaving(true);
    try {
      await api.patch(`/api/accounts/${account.id}`, body);
    } catch { /* reload below resyncs the control on failure */ }
    setSaving(false);
    onDone();
  };

  const changeMode = (next: 'off' | 'pool' | 'single') => {
    setMode(next);
    if (next === 'single') {
      // Only save once a real proxy is picked; the picker below fires it.
      if (proxyUrl) patch({ proxyMode: 'single', proxyUrl });
      return;
    }
    patch({ proxyMode: next });
  };

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        className="input"
        style={{ width: 128, padding: '6px 8px', fontSize: 13 }}
        value={mode}
        disabled={saving}
        onChange={(e) => changeMode(e.target.value as 'off' | 'pool' | 'single')}
        title={mode === 'off' ? 'Direct connection, no proxy' : mode === 'pool' ? 'Round-robin through the whole proxy pool' : 'Pinned to one proxy'}
      >
        <option value="off">Direct</option>
        <option value="pool">Pool (round-robin)</option>
        <option value="single">Single proxy</option>
      </select>
      {mode === 'single' && (
        <select
          className="input"
          style={{ width: 190, padding: '6px 8px', fontSize: 13 }}
          value={proxyUrl}
          disabled={saving || proxies.length === 0}
          onChange={(e) => { setProxyUrl(e.target.value); if (e.target.value) patch({ proxyMode: 'single', proxyUrl: e.target.value }); }}
          title={account.proxyUrl ? `Pinned: ${account.proxyUrl}` : 'Pick the proxy this account always uses'}
        >
          <option value="">{proxies.length === 0 ? 'No proxies in pool' : account.proxyUrl && !matched ? `Pinned: ${account.proxyUrl} (not in pool)` : 'Choose a proxy…'}</option>
          {proxies.map((p) => (
            <option key={p.url} value={p.url}>{redactProxy(p.url)}{p.healthy ? '' : ' (down)'}</option>
          ))}
        </select>
      )}
    </div>
  );
}

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [proxies, setProxies] = useState<ProxyInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [connectProvider, setConnectProvider] = useState<{ id: string; name: string } | null>(null);
  const [tokens, setTokens] = useState<TokenStatus>({ count: 0, collecting: false, collectLog: '' });
  const [showCollector, setShowCollector] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);

  const load = () => {
    api.get<Account[]>('/api/accounts').then(setAccounts).catch(() => {});
    api.get<Provider[]>('/api/providers').then(setProviders).catch(() => {});
    api.get<ProxyInfo[]>('/api/proxies').then(setProxies).catch(() => {});
  };
  const loadTokens = () => api.get<TokenStatus>('/api/zai/tokens').then(setTokens).catch(() => {});
  useEffect(() => {
    load();
    loadTokens();
    const t = setInterval(loadTokens, 5000);
    return () => clearInterval(t);
  }, []);

  const hasZai = accounts.some((a) => a.provider === 'zai');

  const reset = async (id: string) => {
    await api.post(`/api/accounts/${id}/reset`);
    load();
  };

  const remove = async (id: string) => {
    if (!confirm('Remove this account?')) return;
    await api.del(`/api/accounts/${id}`);
    load();
  };

  // Provider cards: every configured provider, plus a ghost card for each
  // connectable provider that hasn't been added yet.
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const orphanIds = [...new Set(accounts.map((a) => a.provider))].filter((id) => !providerById.has(id));
  const cards: { id: string; name: string; baseUrl: string; enabled: boolean; ghost: boolean }[] = [
    ...providers.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, enabled: p.enabled, ghost: false })),
    ...orphanIds.map((id) => ({ id, name: id, baseUrl: '', enabled: true, ghost: false })),
    ...CONNECTABLE.filter((c) => !providerById.has(c.id) && !orphanIds.includes(c.id))
      .map((c) => ({ id: c.id, name: c.name, baseUrl: '', enabled: false, ghost: true })),
  ];

  const selProvider = selected ? providerById.get(selected) : undefined;
  const selAccounts = accounts.filter((a) => a.provider === selected);
  const selName = selProvider?.name || selected || '';

  const openConnect = (id: string, name: string) => setConnectProvider({ id, name });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Accounts</h1>
          <p className="page-sub">{selected ? `${selName} — accounts` : 'Connected provider accounts'}</p>
        </div>
        <div className="page-actions">
          {selected && <button className="btn btn-ghost" onClick={() => setSelected(null)}>← All providers</button>}
          <button className="btn btn-primary" onClick={() => setShowPicker(true)}>+ Connect account</button>
        </div>
      </div>

      {hasZai && !selected && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h3 className="section-title">Z.ai device tokens</h3>
              <p className="section-sub">Z.ai needs a captcha token per chat request. Hadi harvests them automatically — each token is single-use.</p>
              <p>
                <span className="badge badge-active badge-no-dot">{tokens.count} in pool</span>{' '}
                {tokens.collecting && <span className="badge badge-cooling">collecting…</span>}
              </p>
            </div>
            <button className="btn btn-primary" onClick={() => setShowCollector(true)}>Collector setup…</button>
          </div>
        </div>
      )}

      <CollectorDialog open={showCollector} onClose={() => { setShowCollector(false); loadTokens(); }} />

      {selected === null ? (
        // ---- Provider card grid: click a card to open that provider's page.
        <div className="card-grid">
          {cards.length === 0 && (
            <div className="card"><div className="empty"><span className="empty-ic">🔑</span>No providers yet. Connect an account to get started.</div></div>
          )}
          {cards.map((c) => {
            const list = accounts.filter((a) => a.provider === c.id);
            const active = list.filter((a) => a.state !== 'invalid').length;
            const pool = list.filter((a) => proxyModeOf(a) === 'pool').length;
            const single = list.filter((a) => proxyModeOf(a) === 'single').length;
            const direct = list.filter((a) => proxyModeOf(a) === 'off').length;
            return (
              <div
                key={c.id}
                className="card"
                style={{ cursor: 'pointer' }}
                onClick={() => c.ghost ? openConnect(c.id, c.name) : setSelected(c.id)}
                title={c.ghost ? `Connect a ${c.name} account` : `Open ${c.name} accounts`}
              >
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div className="stat-ic" style={{ width: 44, height: 44, fontSize: 20 }}>{PROVIDER_ICON[c.id] || '🔌'}</div>
                  <div style={{ minWidth: 0 }}>
                    <h3 style={{ fontSize: 16 }}>{c.name}</h3>
                    {c.baseUrl && <p style={{ color: 'var(--muted)', fontSize: 12.5, wordBreak: 'break-all' }}>{c.baseUrl}</p>}
                  </div>
                </div>
                <p style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {c.ghost
                    ? <span className="badge badge-neutral badge-no-dot">not added yet</span>
                    : <span className={`badge ${c.enabled ? 'badge-active' : 'badge-invalid'}`}>{c.enabled ? 'enabled' : 'disabled'}</span>}
                  <span className="badge badge-neutral badge-no-dot">{list.length} account{list.length === 1 ? '' : 's'}</span>
                  {list.length > 0 && <span className="badge badge-neutral badge-no-dot">{active} active</span>}
                </p>
                {list.length > 0 && (
                  <p style={{ marginTop: 4, fontSize: 12.5, color: 'var(--muted)' }}>
                    Proxy: {pool} pool · {single} single · {direct} direct
                  </p>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
                  {c.ghost ? (
                    <button className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); openConnect(c.id, c.name); }}>Connect {c.name}</button>
                  ) : (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); setSelected(c.id); }}>Open →</button>
                      <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); openConnect(c.id, c.name); }}>+ Connect account</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        // ---- Provider detail page: this provider's accounts + per-account proxy.
        <div>
          {selProvider && (
            <div className="card">
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div className="stat-ic" style={{ width: 44, height: 44, fontSize: 20 }}>{PROVIDER_ICON[selProvider.id] || '🔌'}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <h3 style={{ fontSize: 17 }}>{selProvider.name}</h3>
                  <p style={{ color: 'var(--muted)', fontSize: 12.5, wordBreak: 'break-all' }}>{selProvider.baseUrl}</p>
                  <p style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span className={`badge ${selProvider.enabled ? 'badge-active' : 'badge-invalid'}`}>{selProvider.enabled ? 'enabled' : 'disabled'}</span>
                    {selProvider.protocol && <span className="badge badge-neutral badge-no-dot">{selProvider.protocol}</span>}
                    <span className="badge badge-neutral badge-no-dot">{selAccounts.length} account{selAccounts.length === 1 ? '' : 's'}</span>
                  </p>
                  {selProvider.models.length > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {selProvider.models.map((m) => (<code key={m}>{m}</code>))}
                    </div>
                  )}
                </div>
                <button className="btn btn-primary" onClick={() => openConnect(selProvider.id, selProvider.name)}>+ Connect account</button>
              </div>
            </div>
          )}

          {selected === 'zai' && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                <div>
                  <h3 className="section-title">Z.ai device tokens</h3>
                  <p className="section-sub">Z.ai needs a captcha token per chat request. Hadi harvests them automatically — each token is single-use.</p>
                  <p>
                    <span className="badge badge-active badge-no-dot">{tokens.count} in pool</span>{' '}
                    {tokens.collecting && <span className="badge badge-cooling">collecting…</span>}
                  </p>
                </div>
                <button className="btn btn-primary" onClick={() => setShowCollector(true)}>Collector setup…</button>
              </div>
            </div>
          )}

          <div className="card">
            {selAccounts.length === 0 ? (
              <div className="empty"><span className="empty-ic">🔑</span>No accounts for {selName} yet.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Name</th><th>Priority</th><th>State</th><th>Proxy</th><th>5h usage</th><th>Latency</th><th></th></tr>
                  </thead>
                  <tbody>
                    {selAccounts.map((a) => (
                      <tr key={a.id}>
                        <td><strong>{a.name}</strong><div style={{ color: 'var(--faint)', fontSize: 12 }}>{a.id}</div></td>
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
                        <td><ProxyControl account={a} proxies={proxies} onDone={load} /></td>
                        <td>{a.usage5h ?? '—'}{a.quotaLimit ? ` / ${a.quotaLimit}` : ''}</td>
                        <td>{a.avgLatencyMs ? `${Math.round(a.avgLatencyMs)}ms` : '—'}</td>
                        <td>
                          <div className="row-actions">
                            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(a)}>Edit</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => reset(a.id)}>Reset</button>
                            <button className="btn btn-danger btn-sm" onClick={() => remove(a.id)}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {showPicker && (
        <div className="modal-overlay" onClick={() => setShowPicker(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div><h2>Choose provider</h2></div>
              <button className="modal-close" onClick={() => setShowPicker(false)}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setShowPicker(false)}>Cancel</button>
            </div>
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

      {editing && (
        <EditAccountModal account={editing} onClose={() => setEditing(null)} onDone={load} />
      )}
    </div>
  );
}
