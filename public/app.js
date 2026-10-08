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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMs = (ms) => ms <= 0 ? '—' : ms < 60000 ? Math.ceil(ms / 1000) + 's' : Math.ceil(ms / 60000) + 'm';
const fmtTime = (t) => new Date(t).toLocaleTimeString();

// ---- section navigation ----
const TITLES = { overview: 'Overview', accounts: 'Accounts', proxies: 'Proxies', settings: 'Settings', events: 'Events', setup: 'Setup' };
document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.sec').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $('#sec-' + b.dataset.sec).classList.add('active');
  $('#secTitle').textContent = TITLES[b.dataset.sec];
});

async function refresh() {
  try {
    const res = await api('/api/status');
    if (!res.ok) throw new Error(res.status);
    renderStatus(await res.json());
  } catch {
    $('#statusPill').textContent = 'offline';
    $('#statusPill').className = 'pill';
  }
}

function accountRows(s, withActions) {
  return s.accounts.map((a) => {
    const resetBtn = a.state === 'invalid' ? `<button class="btn" data-reset="${esc(a.id)}" style="margin-left:6px">Reset</button>` : '';
    const cells = withActions
      ? `<td><code>${esc(a.id)}</code></td><td>${esc(a.name)}</td><td>${esc(a.provider)}</td><td>P${a.priority}</td>`
      : `<td><code>${esc(a.id)}</code><div class="hint">${esc(a.name)}</div></td><td>P${a.priority}</td>`;
    return `<tr>${cells}
      <td><span class="badge ${a.state}">${a.state.replace('_', ' ')}</span></td>
      <td>${fmtMs(a.cooldownEndsInMs)}</td>
      ${withActions ? `<td><button class="btn danger" data-del="${esc(a.id)}">Remove</button>${resetBtn}</td>` : ''}</tr>`;
  }).join('');
}

function renderStatus(s) {
  const active = s.accounts.filter((a) => a.state === 'active').length;
  $('#statusPill').textContent = `● live · ${active}/${s.accounts.length} accounts`;
  $('#statusPill').className = 'pill on';
  $('#egressLabel').textContent = s.ip.current || `direct egress · IPv${s.ip.family}`;

  const m = s.metrics;
  const cards = [
    ['Requests', m.requests], ['Succeeded', m.successes], ['Rate limited', m.rateLimited],
    ['IP rotations', m.rotations], ['Retries', m.retries],
    ['Uptime', `${Math.floor(m.uptimeSec / 60)}<small> min</small>`],
  ];
  $('#statCards').innerHTML = cards.map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  $('#accountsTblMini tbody').innerHTML = accountRows(s, false) || '<tr><td colspan="4" class="hint">no accounts configured</td></tr>';
  const tb = $('#accountsTbl tbody');
  tb.innerHTML = accountRows(s, true) || '<tr><td colspan="7" class="hint">no accounts configured</td></tr>';
  tb.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm(`Remove account ${b.dataset.del}?`)) return;
    await jdel('/api/accounts/' + encodeURIComponent(b.dataset.del));
    refresh();
  });
  tb.querySelectorAll('[data-reset]').forEach((b) => b.onclick = async () => {
    await api('/api/accounts/' + encodeURIComponent(b.dataset.reset) + '/reset', { method: 'POST' });
    refresh();
  });

  $('#proxyHint').textContent = `${s.ip.proxies} configured · ${s.ip.rotations} rotations total`;
  const health = window._health || [];
  $('#proxyList').innerHTML = (window._proxies || []).length === 0
    ? '<li>direct egress — no proxies configured</li>'
    : window._proxies.map((p, i) => {
        const h = health[i];
        const badge = h ? (h.healthy ? '<span class="tag ok">healthy</span>' : '<span class="tag bad">down</span>') : '<span class="tag">checking…</span>';
        return `<li class="${p === s.ip.current ? 'current' : ''}"><span>${esc(p)}${p === s.ip.current ? '<span class="tag">active</span>' : ''}${badge}</span><button class="btn danger" data-px="${esc(p)}">Remove</button></li>`;
      }).join('');
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

async function renderEvents() {
  try {
    const d = await (await api('/api/metrics')).json();
    $('#eventsList').innerHTML = d.events.map((e) =>
      `<li><span class="t">${fmtTime(e.t)}</span><span class="k k-${e.kind}">${e.kind.replace(/_/g, ' ')}</span>${esc(e.detail)}</li>`).join('') || '<li class="hint">no events yet</li>';
  } catch { /* ignore */ }
}

async function loadProxies() {
  try {
    const d = await (await api('/api/proxies')).json();
    window._proxies = d.proxies;
    window._health = d.health;
    $('#proxyForm').proxies.value = d.proxies.join('\n');
  } catch { /* ignore */ }
}

async function loadSettings() {
  try {
    const { settings } = await (await api('/api/settings')).json();
    const f = $('#settingsForm');
    for (const k of ['upstreamBase', 'maxRetries', 'retryBaseMs', 'retryMaxMs', 'defaultCooldownMs', 'requestTimeoutMs', 'port', 'proxyHealthIntervalMs']) {
      if (f[k] && settings[k] !== undefined && settings[k] !== '') f[k].value = settings[k];
    }
    if (f.proxyHealthCheck) f.proxyHealthCheck.checked = settings.proxyHealthCheck !== false;
    if (f.egressFamily && settings.egressFamily) f.egressFamily.value = settings.egressFamily;
  } catch { /* ignore */ }
}

$('#btnRotate').onclick = async () => { await api('/v1/rotate', { method: 'POST' }); refresh(); };

$('#accountForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { id: f.id.value.trim(), name: f.name.value.trim(), provider: f.provider.value.trim(), apiKey: f.apiKey.value.trim(), priority: Number(f.priority.value) };
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
  for (const k of ['upstreamBase', 'maxRetries', 'retryBaseMs', 'retryMaxMs', 'defaultCooldownMs', 'requestTimeoutMs', 'port', 'proxyHealthIntervalMs']) {
    if (f[k].value !== '') body[k] = f[k].type === 'number' ? Number(f[k].value) : f[k].value;
  }
  body.proxyHealthCheck = !!f.proxyHealthCheck.checked;
  if (f.egressFamily && f.egressFamily.value) body.egressFamily = f.egressFamily.value;
  if (f.adminToken.value) { body.adminToken = f.adminToken.value; adminToken = f.adminToken.value; localStorage.setItem('om_admin_token', adminToken); }
  const r = await jpost('/api/settings', body);
  const d = await r.json().catch(() => ({}));
  $('#settingsMsg').textContent = r.ok ? '✓ Saved' + (d.restartRequired ? ' — restart required for the port change.' : '') : 'Save failed.';
  f.adminToken.value = '';
  refresh();
};

$('#btnCopy').onclick = () => {
  navigator.clipboard.writeText($('#opencodeSnippet').textContent).then(() => {
    $('#btnCopy').textContent = '✓ Copied';
    setTimeout(() => $('#btnCopy').textContent = 'Copy snippet', 1500);
  });
};

loadProxies(); loadSettings(); refresh();
setInterval(refresh, 3000);
