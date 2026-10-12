import { useState } from 'react';
import { api } from '../api/client';

interface Props {
  providerId: string;
  providerName: string;
  onClose: () => void;
  onDone: () => void;
}

interface ApiRes {
  ok: boolean;
  error?: string;
  id?: string;
  needCode?: boolean;
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: 10, marginTop: 8, background: 'var(--bg3)',
  border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)',
};

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)',
  background: active ? 'var(--accent)' : 'transparent',
  color: active ? '#fff' : 'var(--text)', cursor: 'pointer',
});

export default function ConnectAccount({ providerId, providerName, onClose, onDone }: Props) {
  const [tab, setTab] = useState<'signin' | 'paste'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [token, setToken] = useState('');
  const [cookies, setCookies] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const showSignin = providerId === 'qwen' || providerId === 'deepseek';

  const createAccount = async (apiKey: string, extraCookies = '') => {
    const acctName = name.trim() || `${providerName} account`;
    const res = await api.post<ApiRes>('/api/accounts', {
      name: acctName,
      provider: providerId,
      apiKey,
      ...(extraCookies ? { cookies: extraCookies } : {}),
    });
    if (!res.ok) throw new Error(res.error || 'failed to save account');
  };

  const doSignin = async () => {
    setBusy(true); setError('');
    try {
      if (providerId === 'qwen') {
        const res = await api.post<ApiRes>('/api/accounts/qwen-login', {
          email: email.trim(), password, name: name.trim() || undefined,
        });
        if (!res.ok) throw new Error(res.error || 'sign-in failed');
        onDone(); onClose();
      } else if (providerId === 'deepseek') {
        const res = await api.post<ApiRes>('/api/accounts/deepseek-login', {
          email: email.trim(), password,
          ...(needCode ? { verificationCode: code.trim() } : {}),
          name: name.trim() || undefined,
        });
        if (res.needCode) { setNeedCode(true); setBusy(false); return; }
        if (!res.ok) throw new Error(res.error || 'sign-in failed');
        onDone(); onClose();
      }
    } catch (e: any) {
      setError(e.message || 'sign-in failed');
    }
    setBusy(false);
  };

  const doPaste = async () => {
    setBusy(true); setError('');
    try {
      const cred = token.trim();
      if (!cred) throw new Error('token is required');
      const ck = cookies.trim();
      if (providerId === 'qwen') {
        const v = await api.post<ApiRes>('/api/accounts/validate-qwen', { credential: cred, cookies: ck });
        if (!v.ok) throw new Error(v.error || 'token rejected');
        await createAccount(cred, ck);
      } else if (providerId === 'deepseek') {
        const v = await api.post<ApiRes>('/api/accounts/validate-deepseek', { credential: cred, cookies: ck });
        if (!v.ok) throw new Error(v.error || 'token rejected');
        await createAccount(cred, ck);
      } else if (providerId === 'zai') {
        const v = await api.post<ApiRes>('/api/accounts/validate-zai', { credential: cred });
        if (!v.ok) throw new Error(v.error || 'token rejected');
        await createAccount(cred);
      } else {
        const v = await api.post<ApiRes>('/api/accounts/validate', { apiKey: cred });
        if (!v.ok) throw new Error(v.error || 'key rejected');
        await createAccount(cred);
      }
      onDone(); onClose();
    } catch (e: any) {
      setError(e.message || 'failed');
    }
    setBusy(false);
  };

  const pasteHint = providerId === 'zai'
    ? 'Sign in at chat.z.ai, then DevTools (F12) → Application → Local Storage → copy the "token" value. Device tokens for captcha are harvested automatically — nothing else needed.'
    : providerId === 'qwen'
    ? 'Sign in at chat.qwen.ai, then DevTools (F12) → Application → Local Storage → copy the "token" value.'
    : providerId === 'deepseek'
    ? 'Sign in at chat.deepseek.com, then copy the session token. Paste-token needs the browser cookies too — sign-in is more reliable.'
    : 'Paste your OpenAI-compatible API key.';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h2>Connect {providerName} account</h2>

        {showSignin && (
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button style={tabStyle(tab === 'signin')} onClick={() => setTab('signin')}>Sign in</button>
            <button style={tabStyle(tab === 'paste')} onClick={() => setTab('paste')}>Paste token</button>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 13, color: 'var(--muted)' }}>Account name (optional)</label>
          <input style={inputStyle} placeholder={`${providerName} account`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        {tab === 'signin' && showSignin ? (
          <div>
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 13, color: 'var(--muted)' }}>Email</label>
              <input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 13, color: 'var(--muted)' }}>Password</label>
              <input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {needCode && (
              <div style={{ marginTop: 12 }}>
                <label style={{ fontSize: 13, color: 'var(--muted)' }}>Verification code (sent to your email)</label>
                <input style={inputStyle} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
              </div>
            )}
            <p style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
              {providerId === 'qwen'
                ? 'Signs in automatically in a headless browser — no DevTools needed.'
                : 'Signs in via the provider API.'}
            </p>
            <button className="btn btn-primary" style={{ marginTop: 16, width: '100%' }} onClick={doSignin} disabled={busy || !email || !password}>
              {busy ? 'Signing in…' : needCode ? 'Verify & connect' : 'Sign in & connect'}
            </button>
          </div>
        ) : (
          <div>
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 13, color: 'var(--muted)' }}>Token / API key</label>
              <textarea style={{ ...inputStyle, minHeight: 80, fontFamily: 'monospace', fontSize: 12 }} value={token} onChange={(e) => setToken(e.target.value)} placeholder="paste here" />
            </div>
            {(providerId === 'qwen' || providerId === 'deepseek') && (
              <div style={{ marginTop: 12 }}>
                <label style={{ fontSize: 13, color: 'var(--muted)' }}>Cookies (optional)</label>
                <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: 'monospace', fontSize: 12 }} value={cookies} onChange={(e) => setCookies(e.target.value)} placeholder="name=value; ..." />
              </div>
            )}
            <p style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>{pasteHint}</p>
            <button className="btn btn-primary" style={{ marginTop: 16, width: '100%' }} onClick={doPaste} disabled={busy || !token.trim()}>
              {busy ? 'Connecting…' : 'Validate & connect'}
            </button>
          </div>
        )}

        {error && <p style={{ marginTop: 12, color: '#f66', fontSize: 13 }}>{error}</p>}

        <button className="btn btn-ghost" style={{ marginTop: 16, width: '100%' }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
