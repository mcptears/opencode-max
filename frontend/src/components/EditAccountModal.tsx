import { useState } from 'react';
import { api } from '../api/client';
import type { Account } from '../api/client';

export default function EditAccountModal({ account, onClose, onDone }: {
  account: Account;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(account.name);
  const [priority, setPriority] = useState(account.priority);
  const [useProxy, setUseProxy] = useState(account.useProxy !== false);
  const [cooldownMs, setCooldownMs] = useState(account.cooldownPeriod ?? 0);
  const [baseUrl, setBaseUrl] = useState(account.baseUrl ?? '');
  const [quotaLimit, setQuotaLimit] = useState(account.quotaLimit ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      // No credentials are sent — the server keeps the stored key/cookies.
      await api.put(`/api/accounts/${account.id}`, {
        id: account.id,
        name: name.trim() || account.id,
        provider: account.provider,
        priority,
        useProxy,
        cooldownPeriod: cooldownMs > 0 ? cooldownMs : undefined,
        baseUrl: baseUrl.trim() || undefined,
        quotaLimit: quotaLimit > 0 ? quotaLimit : undefined,
      });
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
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Route through proxy pool</div>
              <div className="toggle-desc">Off = direct connection. Only OpenCode Zen really needs IP rotation.</div>
            </div>
            <label className="toggle"><input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} /><span className="track" /></label>
          </div>
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
