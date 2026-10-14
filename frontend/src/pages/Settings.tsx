import { useEffect, useState } from 'react';
import { api } from '../api/client';

type Kind = 'text' | 'number' | 'float' | 'bool' | 'select' | 'json' | 'secret' | 'tokens';

interface FieldDef {
  key: string;
  label: string;
  desc: string;
  kind: Kind;
  group: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  clearable?: boolean;
}

const REDACTED = '••••••••';

const FIELDS: FieldDef[] = [
  { key: 'port', label: 'Server port', desc: '0 = PORT env / default 8080. Takes effect after restart.', kind: 'number', group: 'Server' },
  { key: 'upstreamBase', label: 'Upstream base URL', desc: 'OpenCode Zen base URL. Empty = default.', kind: 'text', group: 'Server', placeholder: 'https://opencode.ai/zen/v1' },
  { key: 'adminToken', label: 'Admin token', desc: 'Guards mutating admin endpoints. Empty = open on loopback.', kind: 'secret', group: 'Server', placeholder: 'Leave as-is to keep current', clearable: true },
  { key: 'alertWebhookUrl', label: 'Alert webhook URL', desc: 'POSTed on dead keys / pool exhaustion. Empty keeps current.', kind: 'secret', group: 'Server', placeholder: 'https://…' },
  { key: 'routingStrategy', label: 'Routing strategy', desc: 'Priority: highest-priority account first. Latency: fastest first.', kind: 'select', group: 'Routing', options: [{ value: '', label: 'Default (priority)' }, { value: 'priority', label: 'Priority' }, { value: 'latency', label: 'Latency' }] },
  { key: 'maxRetries', label: 'Max retries', desc: 'Retries per request before failing over.', kind: 'number', group: 'Routing' },
  { key: 'retryBaseMs', label: 'Retry base delay (ms)', desc: 'Initial backoff between retries.', kind: 'number', group: 'Routing' },
  { key: 'retryMaxMs', label: 'Retry max delay (ms)', desc: 'Backoff cap between retries.', kind: 'number', group: 'Routing' },
  { key: 'defaultCooldownMs', label: 'Default cooldown (ms)', desc: 'How long an account stays parked after a failure.', kind: 'number', group: 'Routing' },
  { key: 'requestTimeoutMs', label: 'Request timeout (ms)', desc: '0 = no timeout.', kind: 'number', group: 'Routing' },
  { key: 'queueMaxWaitMs', label: 'Queue max wait (ms)', desc: 'How long a request waits for a cooling account.', kind: 'number', group: 'Routing' },
  { key: 'accountConcurrency', label: 'Per-account concurrency', desc: 'Max parallel in-flight requests per account. 0 = unlimited.', kind: 'number', group: 'Routing' },
  { key: 'quota5hLimit', label: '5h quota per account', desc: 'Rolling 5h request budget per account. 0 = unlimited.', kind: 'number', group: 'Routing' },
  { key: 'proxyHealthCheck', label: 'Proxy health checks', desc: 'Periodically probe proxies and skip down ones.', kind: 'bool', group: 'Proxies' },
  { key: 'proxyHealthIntervalMs', label: 'Health check interval (ms)', desc: 'How often proxies are probed.', kind: 'number', group: 'Proxies' },
  { key: 'proxyAutoDropFails', label: 'Auto-drop after N failures', desc: 'Drop a proxy after this many consecutive real-request failures. 0 = off.', kind: 'number', group: 'Proxies' },
  { key: 'egressFamily', label: 'Direct egress IP family', desc: 'Auto alternates IPv4/IPv6 on direct connections.', kind: 'select', group: 'Proxies', options: [{ value: '', label: 'Default (auto)' }, { value: 'auto', label: 'Auto' }, { value: '4', label: 'IPv4 only' }, { value: '6', label: 'IPv6 only' }] },
  { key: 'tokenSaver', label: 'Token saver (RTK)', desc: 'Compress bloated tool_result payloads before forwarding.', kind: 'bool', group: 'Token saver' },
  { key: 'tokenSaverMaxChars', label: 'Token saver max chars', desc: 'Payloads larger than this get compressed.', kind: 'number', group: 'Token saver' },
  { key: 'logFile', label: 'Log file', desc: 'Mirror console output to a file. Empty = stdout only.', kind: 'text', group: 'Logging', placeholder: '/var/log/hadi.log' },
  { key: 'logMaxMb', label: 'Log max size (MB)', desc: 'Rotate the log file after this size.', kind: 'number', group: 'Logging' },
  { key: 'logKeep', label: 'Log files kept', desc: 'Number of rotated log files to keep.', kind: 'number', group: 'Logging' },
  { key: 'shutdownDrainMs', label: 'Shutdown drain (ms)', desc: 'Bounds graceful shutdown on SIGTERM/SIGINT.', kind: 'number', group: 'Logging' },
  { key: 'errorSpikeThreshold', label: 'Error spike threshold', desc: 'Recent error rate (0–1) that triggers a webhook alert.', kind: 'float', group: 'Alerts' },
  { key: 'errorSpikeWindowMin', label: 'Error spike window (min)', desc: 'Window the error rate is measured over.', kind: 'number', group: 'Alerts' },
  { key: 'errorSpikeMinRequests', label: 'Error spike min requests', desc: 'Minimum requests before a spike can trigger.', kind: 'number', group: 'Alerts' },
  { key: 'autoScrape', label: 'Auto-scrape free proxies', desc: 'Periodically re-scrape free proxy providers.', kind: 'bool', group: 'Advanced' },
  { key: 'autoScrapeIntervalHours', label: 'Scrape interval (hours)', desc: 'How often free proxies are re-scraped.', kind: 'number', group: 'Advanced' },
  { key: 'modelFallbacks', label: 'Model fallbacks', desc: 'JSON: when a model is exhausted everywhere, try these in order.', kind: 'json', group: 'Advanced', placeholder: '{\n  "glm-5.3": ["glm-5.2"]\n}' },
  { key: 'modelTimeouts', label: 'Model timeouts', desc: 'JSON: exact model names or globs to upstream timeouts in ms.', kind: 'json', group: 'Advanced', placeholder: '{\n  "glm-*": 120000\n}' },
  { key: 'clientTokens', label: 'Client API tokens', desc: 'Comma-separated tokens guarding /v1/*. Empty keeps current. Use Clear to remove all.', kind: 'tokens', group: 'Advanced', placeholder: 'token1, token2' },
];

const GROUPS = ['Server', 'Routing', 'Proxies', 'Token saver', 'Logging', 'Alerts', 'Advanced'];

export default function Settings() {
  const [values, setValues] = useState<Record<string, any>>({});
  const [initial, setInitial] = useState<Record<string, any>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [error, setError] = useState('');
  const [clearTokens, setClearTokens] = useState(false);
  const [clearSecrets, setClearSecrets] = useState<Record<string, boolean>>({});

  const load = () => {
    api.get<Record<string, any>>('/api/settings').then((s) => {
      const v: Record<string, any> = { ...s };
      // JSON fields edit as text; tokens start empty (never exposed).
      v.modelFallbacks = s.modelFallbacks ? JSON.stringify(s.modelFallbacks, null, 2) : '';
      v.modelTimeouts = s.modelTimeouts ? JSON.stringify(s.modelTimeouts, null, 2) : '';
      v.clientTokens = '';
      // Secrets edit as empty inputs — the redaction placeholder is never
      // a value. Clearing is explicit via the checkbox below each field.
      v.adminToken = '';
      v.alertWebhookUrl = '';
      setValues(v);
      setInitial({ ...s });
      setClearSecrets({});
      setLoaded(true);
    }).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const set = (k: string, val: any) => setValues((s) => ({ ...s, [k]: val }));

  const save = async () => {
    setError('');
    setSaved(false);
    setRestartRequired(false);
    const patch: Record<string, any> = {};
    for (const f of FIELDS) {
      const val = values[f.key];
      if (f.kind === 'secret') {
        // Never send the redaction placeholder — inputs start empty, so
        // an empty input means "keep". Clearing is explicit via checkbox.
        if (clearSecrets[f.key]) patch[f.key] = '';
        else if (String(val ?? '').trim() !== '') patch[f.key] = String(val).trim();
        continue;
      }
      if (f.kind === 'json') {
        const text = String(val ?? '').trim();
        if (text === '') continue; // empty keeps current
        try {
          patch[f.key] = JSON.parse(text);
        } catch {
          setError(`Invalid JSON in ${f.label}. Nothing was saved.`);
          return;
        }
        continue;
      }
      if (f.kind === 'tokens') {
        const text = String(val ?? '').trim();
        if (clearTokens) patch.clearClientTokens = true;
        else if (text !== '') patch.clientTokens = text;
        continue;
      }
      if (f.kind === 'bool') { patch[f.key] = !!val; continue; }
      if (f.kind === 'number' || f.kind === 'float') {
        const n = Number(val);
        patch[f.key] = Number.isFinite(n) ? n : 0;
        continue;
      }
      patch[f.key] = val ?? '';
    }
    setSaving(true);
    try {
      const r = await api.put<{ ok: boolean; restartRequired?: boolean }>('/api/settings', patch);
      setSaved(true);
      setRestartRequired(!!r.restartRequired);
      setClearTokens(false);
      setTimeout(() => setSaved(false), 3000);
      load();
    } catch (e: any) {
      setError(e.message || 'failed to save');
    }
    setSaving(false);
  };

  if (!loaded) return <div><h1 className="page-title">Settings</h1><p className="page-sub">Server configuration</p></div>;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Server configuration</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save settings'}
          </button>
        </div>
      </div>

      {restartRequired && (
        <div className="card" style={{ borderColor: 'var(--amber)', background: 'var(--amber-soft)' }}>
          <strong>Restart required</strong> — the port changed. Restart the server for it to take effect.
        </div>
      )}
      {error && <div className="card" style={{ borderColor: 'var(--red)' }}><p className="form-error" style={{ marginTop: 0 }}>{error}</p></div>}

      {GROUPS.map((g) => (
        <div className="card" key={g}>
          <h3 className="section-title">{g}</h3>
          {FIELDS.filter((f) => f.group === g).map((f) => {
            const val = values[f.key];
            if (f.kind === 'bool') {
              return (
                <div className="toggle-row" key={f.key}>
                  <div>
                    <div className="toggle-label">{f.label}</div>
                    <div className="toggle-desc">{f.desc}</div>
                  </div>
                  <label className="toggle"><input type="checkbox" checked={!!val} onChange={(e) => set(f.key, e.target.checked)} /><span className="track" /></label>
                </div>
              );
            }
            if (f.kind === 'select') {
              return (
                <label className="field" key={f.key}>
                  <span>{f.label}</span>
                  <select className="input" value={String(val ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                    {(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <small>{f.desc}</small>
                </label>
              );
            }
            if (f.kind === 'json') {
              return (
                <label className="field" key={f.key}>
                  <span>{f.label}</span>
                  <textarea className="input mono" rows={4} value={String(val ?? '')} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} style={{ fontSize: 12.5 }} />
                  <small>{f.desc}</small>
                </label>
              );
            }
            if (f.kind === 'secret') {
              const isSet = initial[f.key] === REDACTED;
              return (
                <div className="field" key={f.key}>
                  <span>{f.label}</span>
                  <input
                    className="input" type="password" value={String(val ?? '')}
                    onChange={(e) => set(f.key, e.target.value)}
                    placeholder={isSet ? '•••••••• set — type a new value to replace' : 'Empty'}
                    autoComplete="off"
                  />
                  <small>{f.desc}</small>
                  {isSet && f.clearable && (
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 13 }}>
                      <input type="checkbox" checked={!!clearSecrets[f.key]} onChange={(e) => setClearSecrets((s) => ({ ...s, [f.key]: e.target.checked }))} />
                      Clear this secret
                    </label>
                  )}
                </div>
              );
            }
            if (f.kind === 'tokens') {
              return (
                <div className="field" key={f.key}>
                  <span>{f.label}</span>
                  <input className="input" value={String(val ?? '')} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />
                  <small>{f.desc}</small>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 13 }}>
                    <input type="checkbox" checked={clearTokens} onChange={(e) => setClearTokens(e.target.checked)} />
                    Clear all client tokens
                  </label>
                </div>
              );
            }
            return (
              <label className="field" key={f.key}>
                <span>{f.label}</span>
                <input
                  className="input"
                  type={f.kind === 'number' || f.kind === 'float' ? 'number' : 'text'}
                  step={f.kind === 'float' ? '0.01' : undefined}
                  min={f.kind === 'number' || f.kind === 'float' ? 0 : undefined}
                  value={val ?? ''}
                  onChange={(e) => set(f.key, f.kind === 'number' || f.kind === 'float' ? e.target.value : e.target.value)}
                  placeholder={f.placeholder}
                  autoComplete="off"
                />
                <small>{f.desc}</small>
              </label>
            );
          })}
        </div>
      ))}

      <button className="btn btn-primary btn-lg" onClick={save} disabled={saving} style={{ marginTop: 4 }}>
        {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save settings'}
      </button>
    </div>
  );
}
