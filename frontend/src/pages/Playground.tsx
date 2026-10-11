import { useEffect, useState, useRef } from 'react';
import { api } from '../api/client';

interface Msg { role: 'user' | 'assistant' | 'error'; content: string }

export default function Playground() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<string[]>('/api/playground/models').then((m) => {
      setModels(m);
      if (m.length) setModel(m[0]);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    boxRef.current?.scrollTo(0, boxRef.current.scrollHeight);
  }, [msgs]);

  const send = async () => {
    if (!input.trim() || busy) return;
    const history = [...msgs, { role: 'user' as const, content: input.trim() }];
    setMsgs(history);
    setInput('');
    setBusy(true);
    try {
      const r = await fetch('/api/playground/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: history.filter((m) => m.role !== 'error').map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!r.ok) throw new Error((await r.text()).slice(0, 200));
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '', content = '';
      setMsgs((h) => [...h, { role: 'assistant', content: '' }]);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const p of parts) {
          const line = p.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            content += j.choices?.[0]?.delta?.content || '';
            setMsgs((h) => {
              const nh = [...h];
              nh[nh.length - 1] = { role: 'assistant', content };
              return nh;
            });
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      setMsgs((h) => [...h, { role: 'error', content: `✕ ${e instanceof Error ? e.message : e}` }]);
    }
    setBusy(false);
  };

  return (
    <div>
      <h1 className="page-title">Playground</h1>
      <p className="page-sub">Chat with a connected model to verify it before wiring it to external agents</p>
      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <select value={model} onChange={(e) => setModel(e.target.value)} style={{ flex: 1 }}>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={() => setMsgs([])}>New chat</button>
        </div>
        <div className="chat-box" ref={boxRef}>
          {msgs.map((m, i) => (
            <div key={i} className={`msg msg-${m.role}`}>{m.content || '…'}</div>
          ))}
        </div>
        <div className="chat-input">
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          />
          <button className="btn btn-primary" onClick={send} disabled={busy}>Send</button>
        </div>
      </div>
    </div>
  );
}
