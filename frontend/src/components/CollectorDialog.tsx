import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface TokenStatus {
  count: number;
  collecting: boolean;
  collectLog: string;
}

type Preset = 'quick' | 'standard' | 'max' | 'custom';

const PRESETS: Record<Exclude<Preset, 'custom'>, { tokens: number; batches: number; parallel: number; label: string }> = {
  quick: { tokens: 20, batches: 1, parallel: 1, label: 'Quick' },
  standard: { tokens: 850, batches: 5, parallel: 1, label: 'Standard' },
  max: { tokens: 1500, batches: 9, parallel: 3, label: 'Max' },
};

export default function CollectorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [preset, setPreset] = useState<Preset>('quick');
  const [tokens, setTokens] = useState(20);
  const [batches, setBatches] = useState(1);
  const [parallel, setParallel] = useState(1);
  const [headed, setHeaded] = useState(false);
  const [blockTrackers, setBlockTrackers] = useState(false);
  const [unsafe, setUnsafe] = useState(false);
  const [status, setStatus] = useState<TokenStatus>({ count: 0, collecting: false, collectLog: '' });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const maxBatches = unsafe ? 25 : 9;
  const maxParallel = unsafe ? 5 : 3;
  const total = tokens * batches;

  const load = () => api.get<TokenStatus>('/api/zai/tokens').then(setStatus).catch(() => {});

  useEffect(() => {
    if (!open) return;
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [open ]);

  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') {
      const v = PRESETS[p];
      setTokens(v.tokens);
      setBatches(v.batches);
      setParallel(v.parallel);
    }
  };

  const start = async () => {
    setStarting(true);
    setError('');
    try {
      await api.post('/api/zai/tokens/collect', {
        tokens, batches, parallel, headed, blockTrackers, unsafe,
      });
      load();
    } catch (e: any) {
      setError(e.message || 'failed to start collection');
    }
    setStarting(false);
  };

  const clear = async () => {
    if (!confirm('Clear all pooled device tokens?')) return;
    await api.del('/api/zai/tokens');
    load();
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Z.ai token collector</h2>
            <p>Harvests device tokens from a headless browser at chat.z.ai. One chat message per batch — tokens come from the loaded SDK, not from messages.</p>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="seg" style={{ marginBottom: 16 }}>
            {(['quick', 'standard', 'max', 'custom'] as Preset[]).map((p) => (
              <button key={p} className={preset === p ? 'active' : ''} onClick={() => applyPreset(p)}>
                {p === 'quick' ? 'Quick · 20' : p === 'standard' ? 'Standard · 4,250' : p === 'max' ? 'Max · 13,500' : 'Custom'}
              </button>
            ))}
          </div>

          <div className="form-grid">
            <label className="field">
              <span>Tokens per batch</span>
              <input
                className="input" type="number" min={1} max={1500} value={tokens}
                onChange={(e) => { setPreset('custom'); setTokens(Math.max(1, Math.min(1500, Number(e.target.value) || 1))); }}
              />
              <small>Max 1,500 per batch.</small>
            </label>
            <label className="field">
              <span>Batches</span>
              <input
                className="input" type="number" min={1} max={maxBatches} value={batches}
                onChange={(e) => { setPreset('custom'); setBatches(Math.max(1, Math.min(maxBatches, Number(e.target.value) || 1))); }}
              />
              <small>Max {maxBatches} batches{unsafe ? ' (unsafe)' : ''}. One chat message per batch.</small>
            </label>
            <label className="field">
              <span>Parallel workers</span>
              <input
                className="input" type="number" min={1} max={maxParallel} value={parallel}
                onChange={(e) => { setPreset('custom'); setParallel(Math.max(1, Math.min(maxParallel, Number(e.target.value) || 1))); }}
              />
              <small>Max {maxParallel} browser pages at once{unsafe ? ' (unsafe)' : ''}.</small>
            </label>
            <div className="field">
              <span>Estimated total</span>
              <div className="stat" style={{ fontSize: 22 }}>{total.toLocaleString()} <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>tokens</span></div>
              <small>Each token is single-use — one chat request per token.</small>
            </div>
          </div>

          <div className="toggle-row">
            <div>
              <div className="toggle-label">Show browser window</div>
              <div className="toggle-desc">Headed mode — watch the collector work. Useful for debugging.</div>
            </div>
            <label className="toggle"><input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} /><span className="track" /></label>
          </div>
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Block trackers</div>
              <div className="toggle-desc">URL allowlist — blocks tracker requests during collection.</div>
            </div>
            <label className="toggle"><input type="checkbox" checked={blockTrackers} onChange={(e) => setBlockTrackers(e.target.checked)} /><span className="track" /></label>
          </div>
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Unsafe mode</div>
              <div className="toggle-desc">Raises limits: up to 25 batches, 5 parallel workers. Heavier on the browser.</div>
            </div>
            <label className="toggle"><input type="checkbox" checked={unsafe} onChange={(e) => setUnsafe(e.target.checked)} /><span className="track" /></label>
          </div>

          <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="badge badge-active badge-no-dot">{status.count} in pool</span>
            {status.collecting && <span className="badge badge-cooling">collecting…</span>}
            <button className="btn btn-ghost btn-sm" onClick={clear} disabled={status.collecting}>Clear pool</button>
          </div>
          {status.collectLog && <div className="log-pre" style={{ marginTop: 12 }}>{status.collectLog}</div>}
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={start} disabled={starting || status.collecting}>
            {status.collecting ? 'Collecting…' : starting ? 'Starting…' : `Start collection · ${total.toLocaleString()} tokens`}
          </button>
        </div>
      </div>
    </div>
  );
}
