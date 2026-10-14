import { useEffect, useState } from 'react';
import { api, proxyModeOf, redactProxy } from '../api/client';
import type { Account, ProxyInfo } from '../api/client';

export default function EditAccountModal({ account, onClose, onDone }: {
  account: Account;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(account.name);
  const [priority, setPriority] = useState(account.priority);
  const [proxyMode, setProxyMode] = useState<'off' | 'pool' | 'single'>(proxyModeOf(account));
  const [proxies, setProxies] = useState<ProxyInfo[]>([]);
  const [proxyUrl, setProxyUrl] = useState('');
  const [cooldownMs, setCooldownMs] = useState(account.cooldownPeriod ?? 0);
  const [baseUrl, setBaseUrl] = useState(account.baseUrl ?? '');
  const [quotaLimit, setQuotaLimit] = useState(account.quotaLimit ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<ProxyInfo[]>('/api/proxies').then((list) => {
      setProxies(list);
      const matched = list.find((p) => redactProxy(p.url) === (account.proxyUrl || ''));
      if (matched) setProxyUrl(matched.url);
    }).catch(() => {});
  }, [account.proxyUrl]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      // No credentials are sent — the server keeps the stored key/cookies.
      // proxyUrl is only sent when a pool proxy is picked; when mode is
      // "single" and nothing is picked, the key is omitted and the server
      // keeps the stored pinned proxy.
      const body: Record<string, unknown> = {
        id: account.id,
        name: name.trim() || account.id,
        provider: account.provider,
        priority,
        proxyMode,
        cooldownPeriod: cooldownMs > 0 ? cooldownMs : undefined,
        baseUrl: baseUrl.trim() || undefined,
        quotaLimit: quotaLimit > 0 ? quotaLimit : undefined,
      };
      if (proxyMode === 'single' && proxyUrl) body.proxyUrl = proxyUrl;
      await api.put(`/api/accounts/${account.id}`, body);
      onDone();
      onClose();
    } catch (e: any) {
      setError(e.message || 'failed to save');
    }
    setSaving(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Edit account</h2>
            <p>{account.provider} · {account.id}</p>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Priority</span>
            <input className="input" type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value) || 0)} />
            <small>Lower number = tried first. 0 is the default.</small>
          </label>
          <label className="field">
            <span>Base URL override</span>
            <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Leave empty for the provider default" />
          </label>
          <label className="field">
            <span>Cooldown after rate limit (ms)</span>
            <input className="input" type="number" min={0} value={cooldownMs} onChange={(e) => setCooldownMs(Number(e.target.value) || 0)} />
            <small>How long the account stays parked after a 429/quota hit. 0 = provider default.</small>
          </label>
          <label className="field">
            <span>5h request budget</span>
            <input className="input" type="number" min={0} value={quotaLimit} onChange={(e) => setQuotaLimit(Number(e.target.value) || 0)} />
            <small>Max requests in a rolling 5h window. 0 = unlimited.</small>
          </label>
          <div className="field">
            <span>Proxy</span>
            <select className="input" value={proxyMode} onChange={(e) => setProxyMode(e.target.value as 'off' | 'pool' | 'single')}>
              <option value="off">Direct — no proxy</option>
              <option value="pool">Pool — round-robin through all proxies</option>
              <option value="single">Single proxy — always use one proxy</option>
            </select>
            <small>{proxyMode === 'off' ? 'Direct connection. Only OpenCode Zen really needs IP rotation.' : proxyMode === 'pool' ? 'Each request uses the next proxy in the pool, covering all of them.' : 'Every request for this account goes through the same proxy.'}</small>
          </div>
          {proxyMode === 'single' && (
            <label className="field">
              <span>Pinned proxy</span>
              <select className="input" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} disabled={proxies.length === 0}>
                <option value="">{proxies.length === 0 ? 'No proxies in pool' : account.proxyUrl ? `Keep pinned proxy (${account.proxyUrl})` : 'Choose a proxy…'}</option>
                {proxies.map((p) => (
                  <option key={p.url} value={p.url}>{redactProxy(p.url)}{p.healthy ? '' : ' (down)'}</option>
                ))}
              </select>
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>
    </div>
  );
}
