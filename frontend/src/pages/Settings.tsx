import { useEffect, useState } from 'react';
import { api } from '../api/client';

export default function Settings() {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<Record<string, unknown>>('/api/settings').then(setSettings).catch(() => {});
  }, []);

  const save = async () => {
    await api.put('/api/settings', settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const set = (k: string, v: unknown) => setSettings((s) => ({ ...s, [k]: v }));

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Server configuration</p>
      <div className="card">
        <div className="form-grid">
          {Object.entries(settings).map(([k, v]) => (
            <label key={k}>
              <span>{k}</span>
              <input
                className="input"
                value={String(v ?? '')}
                onChange={(e) => set(k, e.target.value)}
              />
            </label>
          ))}
        </div>
        <button className="btn btn-primary" onClick={save}>Save{saved ? ' ✓' : ''}</button>
      </div>
    </div>
  );
}
