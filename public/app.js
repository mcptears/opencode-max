/* opencode-max dashboard — vanilla JS, no build step */
const $ = (s) => document.querySelector(s);
let adminToken = localStorage.getItem('om_admin_token') || '';

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && !opts._retried) {
    const t = prompt('Admin token required:');
    if (t) {
      adminToken = t;
      localStorage.setItem('om_admin_token', t);
      return api(path, { ...opts, _retried: true });
    }
  }
  return res;
}
const jpost = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const jdel = (p) => api(p, { method: 'DELETE' });

const fmtMs = (ms) => ms <= 0 ? '—' : ms < 60000 ? Math.ceil(ms / 1000) + 's' : Math.ceil(ms / 60000) + 'm';
const fmtTime = (t) => new Date(t).toLocaleTimeString();

let lastStatus = null;

async function refresh() {
  try {
    const res = await api('/api/status');
    if (!res.ok) throw new Error(res.status);
    lastStatus = await res.json();
    renderStatus(lastStatus);
  } catch (e) {
    $('#statusPill').textContent = 'offline';
    $('#statusPill').className = 'pill';
  }
}

function renderStatus(s) {
  const active = s.accounts.filter((a) => a.state === 'active').length;
  $('#statusPill').textContent = `● running · ${active}/${s.accounts.length} accounts`;
  $('#statusPill').className = 'pill on';
  const m = s.metrics;
  const cards = [
    ['Requests', m.requests], ['Success', m.successes], ['429s', m.rateLimited],
    ['Rotations', m.rotations], ['Retries', m.retries],
    ['Uptime', `<small>${Math.floor(m.uptimeSec / 60)}m</small>`],
    ['Egress', s.ip.current ? `<small style="word-break:break-all">${esc(s.ip.current)}</small>` : '<small>direct</small>'],
  ];
  $('#statCards').innerHTML = cards.map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  const tb = $('#accountsTbl tbody');
  tb.innerHTML = s.accounts.map((a) => `<tr>
    <td><code>${esc(a.id)}</code></td><td>${esc(a.name)}</td><td>${esc(a.provider)}</td>
    <td>P${a.priority}</td>
    <td><span class="badge ${a.state}">${a.state.replace('_', ' ')}</span></td>
    <td>${fmtMs(a.cooldownEndsInMs)}</td>
    <td><button class="btn danger" data-del="${esc(a.id)}">Remove</button></td>
  </tr>`).join('');
  tb.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm(`Remove account ${b.dataset.del}?`)) return;
    await jdel('/api/accounts/' + encodeURIComponent(b.dataset.del));
    refresh();
  });

  $('#proxyHint').textContent = `${s.ip.proxies} configured · ${s.ip.rotations} rotations`;
  $('#proxyList').innerHTML = s.ip.proxies === 0
    ? '<li>direct egress (no proxies configured)</li>'
    : (window._proxies || []).map((p) =>
        `<li class="${p === s.ip.current ? 'current' : ''}"><span>${esc(p)}</span><button class="btn danger" data-px="${esc(p)}">Remove</button></li>`).join('');
  document.querySelectorAll('#proxyList [data-px]').forEach((b) => b.onclick = async () => {
    await api('/api/proxies?proxy=' + encodeURIComponent(b.dataset.px), { method: 'DELETE' });
    loadProxies(); refresh();
  });

  renderEvents();
  const port = location.port || '8080';
  $('#opencodeSnippet').textContent =
`// ~/.config/opencode/opencode.jsonc
{
  "provider": {
    "opencode-max": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:${port}/v1",
        "apiKey": "any"
      }
    }
  }
}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function renderEvents() {
  try {
    const r = await api('/api/metrics');
    const { events } = await r.json();
    $('#eventsList').innerHTML = events.map((e) =>
      `<li><span class="t">${fmtTime(e.t)}</span><span class="k k-${e.kind}">${e.kind}</span>${esc(e.detail)}</li>`).join('') || '<li>no events yet</li>';
  } catch { /* ignore */ }
}

async function loadProxies() {
  try {
    const r = await api('/api/proxies');
    const d = await r.json();
    window._proxies = d.proxies;
    $('#proxyForm').proxies.value = d.proxies.join('\n');
  } catch { /* ignore */ }
}

async function loadSettings() {
  try {
    const r = await api('/api/settings');
    const { settings } = await r.json();
    const f = $('#settingsForm');
    for (const k of ['upstreamBase', 'maxRetries', 'retryBaseMs', 'retryMaxMs', 'defaultCooldownMs', 'requestTimeoutMs', 'port']) {
      if (f[k] && settings[k] !== undefined) f[k].value = settings[k];
    }
  } catch { /* ignore */ }
}

$('#btnRotate').onclick = async () => { await api('/v1/rotate', { method: 'POST' }); refresh(); };

$('#accountForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    id: f.id.value.trim(), name: f.name.value.trim(), provider: f.provider.value.trim(),
    apiKey: f.apiKey.value.trim(), priority: Number(f.priority.value),
  };
  if (f.cooldownPeriod.value) body.cooldownPeriod = Number(f.cooldownPeriod.value);
  const r = await jpost('/api/accounts', body);
  if (r.ok) { f.reset(); f.provider.value = 'opencode-zen'; f.priority.value = '1'; }
  else alert('Failed: ' + (await r.text()).slice(0, 200));
  refresh();
};

$('#proxyForm').onsubmit = async (e) => {
  e.preventDefault();
  const proxies = e.target.proxies.value.split('\n').map((s) => s.trim()).filter(Boolean);
  await jpost('/api/proxies', { proxies });
  loadProxies(); refresh();
};

$('#settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, body = {};
  for (const k of ['upstreamBase', 'maxRetries', 'retryBaseMs', 'retryMaxMs', 'defaultCooldownMs', 'requestTimeoutMs', 'port']) {
    if (f[k].value !== '') body[k] = f[k].type === 'number' ? Number(f[k].value) : f[k].value;
  }
  if (f.adminToken.value) { body.adminToken = f.adminToken.value; adminToken = f.adminToken.value; localStorage.setItem('om_admin_token', adminToken); }
  const r = await jpost('/api/settings', body);
  const d = await r.json().catch(() => ({}));
  $('#settingsMsg').textContent = r.ok ? 'Saved ✓' + (d.restartRequired ? ' — restart required for port change.' : '') : 'Save failed.';
  f.adminToken.value = '';
  refresh();
};

$('#btnCopy').onclick = () => {
  navigator.clipboard.writeText($('#opencodeSnippet').textContent).then(() => {
    $('#btnCopy').textContent = 'Copied ✓';
    setTimeout(() => $('#btnCopy').textContent = 'Copy snippet', 1500);
  });
};

loadProxies(); loadSettings(); refresh();
setInterval(refresh, 3000);
