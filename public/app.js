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
  showSection(b.dataset.sec);
});

function showSection(name, title) {
  document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.sec').forEach((x) => x.classList.remove('active'));
  const navBtn = document.querySelector(`nav button[data-sec="${name}"]`);
  if (navBtn) navBtn.classList.add('active');
  $('#sec-' + name).classList.add('active');
  $('#secTitle').textContent = title || TITLES[name] || name;
}

async function refresh() {
  try {
    const res = await api('/api/status');
    if (!res.ok) throw new Error(res.status);
    renderStatus(await res.json());
    drawTraffic();
    loadModels();
    loadUsage();
    loadProviderHealth();
    loadRequests();
  } catch {
    $('#statusPill').textContent = 'offline';
    $('#statusPill').className = 'pill';
  }
}

function accountRows(s, withActions) {
  const globalLimit = s.quota5hLimit || 200;
  return s.accounts.map((a) => {
    const resetBtn = a.state === 'invalid' ? `<button class="btn" data-reset="${esc(a.id)}" style="margin-left:6px">Reset</button>` : '';
    const editBtn = withActions ? `<button class="btn" data-edit="${esc(a.id)}" style="margin-left:6px">Edit</button>` : '';
    const limit = a.quotaLimit || globalLimit;
    const usage = a.usage5h || 0;
    const usageCell = `<td><span class="${usage >= limit ? 'tag bad' : usage >= limit * 0.9 ? 'tag warn' : ''}">${usage}/${limit}</span>${a.inflight > 0 ? ` <span class="hint">· ${a.inflight} in flight</span>` : ''}</td>`;
    const latencyCell = `<td>${a.avgLatencyMs ? a.avgLatencyMs + '<small> ms</small>' : '<span class="hint">—</span>'}</td>`;
    const cells = withActions
      ? `<td><code>${esc(a.id)}</code></td><td>${esc(a.name)}</td><td>${esc(a.provider)}</td><td>P${a.priority}</td>${usageCell}${latencyCell}`
      : `<td><code>${esc(a.id)}</code><div class="hint">${esc(a.name)}</div></td><td>P${a.priority}</td>${usageCell}`;
    return `<tr>${cells}
      <td><span class="badge ${a.state}">${a.state.replace('_', ' ')}</span></td>
      <td>${fmtMs(a.cooldownEndsInMs)}</td>
      ${withActions ? `<td><button class="btn danger" data-del="${esc(a.id)}">Remove</button>${editBtn}${resetBtn}</td>` : ''}</tr>`;
  }).join('');
}

let lastChartDraw = 0;
async function drawTraffic() {
  const now = Date.now();
  if (now - lastChartDraw < 10000) return; // throttle
  lastChartDraw = now;
  const cv = $('#trafficChart');
  if (!cv || !cv.isConnected) return;
  let buckets = [];
  try {
    buckets = (await (await api('/api/metrics/history?hours=24')).json()).buckets;
  } catch { return; }
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600, h = 120;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!buckets.length) {
    ctx.fillStyle = '#8a8fb0'; ctx.font = '12px sans-serif';
    ctx.fillText('no traffic yet', 12, h / 2);
    return;
  }
  const max = Math.max(1, ...buckets.map((b) => b.requests));
  const bw = w / buckets.length;
  buckets.forEach((b, i) => {
    const bh = Math.max(2, (b.requests / max) * (h - 24));
    const x = i * bw + bw * 0.15, ww = bw * 0.7;
    const grad = ctx.createLinearGradient(0, h - bh, 0, h);
    grad.addColorStop(0, '#7c5cff'); grad.addColorStop(1, '#00d4ff');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, h - 16 - bh, ww, bh, 3);
    ctx.fill();
    if (b.rateLimited > 0) {
      ctx.fillStyle = '#ffb02e';
      ctx.beginPath();
      ctx.arc(x + ww / 2, h - 16 - bh - 5, 3, 0, 7);
      ctx.fill();
    }
  });
  ctx.fillStyle = '#8a8fb0'; ctx.font = '10px sans-serif';
  const first = new Date(buckets[0].hour), last = new Date(buckets[buckets.length - 1].hour);
  ctx.fillText(first.toLocaleString([], { hour: 'numeric' }), 4, h - 2);
  const lt = last.toLocaleString([], { hour: 'numeric' });
  ctx.fillText(lt, w - ctx.measureText(lt).width - 4, h - 2);
}

async function loadModels() {
  try {
    const { models } = await (await api('/api/metrics/models?hours=24')).json();
    $('#modelsTbl tbody').innerHTML = (models || []).map((m) => {
      const errPct = m.requests ? Math.round((m.errors / m.requests) * 100) : 0;
      return `<tr><td><code>${esc(m.model)}</code></td><td>${esc(m.provider)}</td><td>${m.requests}</td>` +
        `<td>${m.errors} <span class="hint">(${errPct}%)</span></td><td>${m.avgLatencyMs}<small> ms</small></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="hint">no requests yet</td></tr>';
  } catch { /* ignore */ }
}

const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

async function loadUsage() {
  try {
    const { byAccount } = await (await api('/api/usage?hours=24')).json();
    $('#usageTbl tbody').innerHTML = (byAccount || []).map((u) =>
      `<tr><td><code>${esc(u.accountId)}</code></td><td>${fmtTok(u.prompt)}</td><td>${fmtTok(u.completion)}</td>` +
      `<td><strong>${fmtTok(u.total)}</strong></td><td>${u.requests}</td></tr>`,
    ).join('') || '<tr><td colspan="5" class="hint">no token data yet</td></tr>';
  } catch { /* ignore */ }
}

async function loadProviderHealth() {
  try {
    const { providers } = await (await api('/api/metrics/providers?hours=24')).json();
    $('#provHealthTbl tbody').innerHTML = (providers || []).map((p) => {
      const cls = p.successRate >= 99 ? 'tag ok' : p.successRate >= 90 ? 'tag warn' : 'tag bad';
      const lastErr = p.lastErrorAt
        ? `${p.lastErrorStatus} <span class="hint">${new Date(p.lastErrorAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`
        : '<span class="hint">—</span>';
      return `<tr><td><code>${esc(p.provider)}</code></td><td>${p.requests}</td>` +
        `<td><span class="${cls}">${p.successRate}%</span></td><td>${p.avgLatencyMs}<small> ms</small></td><td>${lastErr}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="hint">no requests yet</td></tr>';
  } catch { /* ignore */ }
}

async function loadRequests() {
  try {
    const { requests } = await (await api('/api/requests?limit=30')).json();
    $('#requestsTbl tbody').innerHTML = (requests || []).map((r) => {
      const time = new Date(r.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const cls = r.status >= 500 ? 'tag bad' : r.status >= 400 ? 'tag warn' : 'tag ok';
      return `<tr><td>${time}</td><td><code>${esc(r.model || '—')}</code></td><td>${esc(r.provider)}</td>` +
        `<td><code>${esc(r.accountId)}</code></td><td><span class="${cls}">${r.status}</span></td><td>${r.latencyMs}<small> ms</small></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="hint">no requests yet</td></tr>';
  } catch { /* ignore */ }
}

function renderStatus(s) {
  window._lastStatus = s;
  const active = s.accounts.filter((a) => a.state === 'active').length;
  $('#statusPill').textContent = `● live · ${active}/${s.accounts.length} accounts`;
  $('#statusPill').className = 'pill on';
  $('#egressLabel').textContent = s.ip.current || `direct egress · IPv${s.ip.family}`;

  const m = s.metrics;
  const fmtTokens = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0);
  const cards = [
    ['Requests', m.requests], ['Succeeded', m.successes], ['Rate limited', m.rateLimited],
    ['IP rotations', m.rotations], ['Retries', m.retries], ['Failovers', m.failovers || 0], ['Tokens saved', fmtTokens(m.tokensSaved)],
    ['Uptime', `${Math.floor(m.uptimeSec / 60)}<small> min</small>`],
  ];
  $('#statCards').innerHTML = cards.map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  $('#accountsTblMini tbody').innerHTML = accountRows(s, false) || '<tr><td colspan="5" class="hint">no accounts configured</td></tr>';
  renderProviderCards();

  $('#proxyHint').textContent = `${s.ip.proxies} configured · ${s.ip.rotations} rotations total`;
  const health = window._health || [];
  $('#proxyList').innerHTML = (window._proxies || []).length === 0
    ? '<li>direct egress — no proxies configured</li>'
    : window._proxies.map((p, i) => {
        const h = health[i];
        const badge = h ? (h.healthy ? '<span class="tag ok">healthy</span>' : '<span class="tag bad">down</span>') : '<span class="tag">checking…</span>';
        const q = h && (h.qualityOk + h.qualityFail) > 0
          ? `<span class="hint"> · ${h.qualityOk}/${h.qualityOk + h.qualityFail} ok${h.qualityLatencyMs ? ` · ${h.qualityLatencyMs}ms` : ''}</span>`
          : '';
        return `<li class="${p === s.ip.current ? 'current' : ''}"><span>${esc(p)}${p === s.ip.current ? '<span class="tag">active</span>' : ''}${badge}${q}</span><button class="btn danger" data-px="${esc(p)}">Remove</button></li>`;
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
    for (const k of ['upstreamBase', 'maxRetries', 'retryBaseMs', 'retryMaxMs', 'defaultCooldownMs', 'requestTimeoutMs', 'port', 'proxyHealthIntervalMs', 'quota5hLimit', 'tokenSaverMaxChars', 'autoScrapeIntervalHours', 'queueMaxWaitMs', 'accountConcurrency', 'proxyAutoDropFails', 'errorSpikeThreshold', 'errorSpikeWindowMin', 'errorSpikeMinRequests', 'logFile', 'logMaxMb', 'logKeep', 'shutdownDrainMs']) {
      if (f[k] && settings[k] !== undefined && settings[k] !== '') f[k].value = settings[k];
    }
    if (f.proxyHealthCheck) f.proxyHealthCheck.checked = settings.proxyHealthCheck !== false;
    if (f.egressFamily && settings.egressFamily) f.egressFamily.value = settings.egressFamily;
    if (f.tokenSaver) f.tokenSaver.checked = settings.tokenSaver !== false;
    if (f.autoScrape) f.autoScrape.checked = settings.autoScrape === true;
    if (f.routingStrategy && settings.routingStrategy) f.routingStrategy.value = settings.routingStrategy;
    if (f.modelFallbacks) f.modelFallbacks.value = JSON.stringify(settings.modelFallbacks || {}, null, 1);
    if (f.modelTimeouts) f.modelTimeouts.value = JSON.stringify(settings.modelTimeouts || {}, null, 1);
    const ctc = $('#clientTokensCount');
    if (ctc) ctc.textContent = settings.clientTokensCount ? `${settings.clientTokensCount} configured` : 'none — proxy is open';
  } catch { /* ignore */ }
}

$('#btnRotate').onclick = async () => { await api('/v1/rotate', { method: 'POST' }); refresh(); };

// ---- backup / restore ----
$('#btnBackupExport').onclick = async () => {
  const r = await api('/api/backup');
  if (!r.ok) { $('#backupMsg').textContent = 'Export failed (admin token required?).'; return; }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `opencode-max-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $('#backupMsg').textContent = '✓ Backup downloaded — store it somewhere safe, it contains API keys.';
};
$('#backupFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm(`Restore configuration from ${file.name}? This replaces accounts, providers, scraper providers and settings.`)) return;
  try {
    const payload = JSON.parse(await file.text());
    const r = await api('/api/backup/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    $('#backupMsg').textContent = r.ok ? '✓ Backup restored.' : `Restore failed: ${d.error?.message || r.status}`;
    if (r.ok) { loadSettings(); refresh(); }
  } catch {
    $('#backupMsg').textContent = 'Restore failed: not a valid backup file.';
  }
};

// ---- Connect-account modal: link -> sign in anywhere -> paste key -> validated & added ----
const connectModal = $('#connectModal');
function openConnect() {
  $('#connectKey').value = '';
  $('#connectName').value = '';
  $('#connectMsg').textContent = '';
  $('#connectGo').disabled = false;
  $('#connectGo').textContent = 'Validate & connect';
  connectModal.hidden = false;
}
function closeConnect() { connectModal.hidden = true; }
const _connectBtn = $('#connectBtn');
if (_connectBtn) _connectBtn.onclick = openConnect;
$('#connectClose').onclick = closeConnect;
$('#connectCancel').onclick = closeConnect;
connectModal.addEventListener('click', (e) => { if (e.target === connectModal) closeConnect(); });
$('#copyLinkBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#connectLink').textContent);
    $('#copyLinkBtn').textContent = 'Copied!';
    setTimeout(() => { $('#copyLinkBtn').textContent = 'Copy link'; }, 1500);
  } catch { /* clipboard unavailable */ }
};
$('#connectGo').onclick = async () => {
  const key = $('#connectKey').value.trim();
  const msg = $('#connectMsg');
  if (!key) { msg.textContent = 'Paste an API key first.'; return; }
  $('#connectGo').disabled = true;
  $('#connectGo').textContent = 'Validating…';
  msg.textContent = 'Checking the key against upstream…';
  try {
    const v = await (await api('/api/accounts/validate', { method: 'POST', body: JSON.stringify({ apiKey: key }) })).json();
    if (!v.ok) {
      msg.textContent = '✕ ' + (v.error || 'invalid key');
      $('#connectGo').disabled = false;
      $('#connectGo').textContent = 'Validate & connect';
      return;
    }
    msg.textContent = '✓ Key is good — adding to the pool…';
    const list = await (await api('/api/accounts')).json();
    const ids = new Set((list.accounts || []).map((a) => a.id));
    let n = 1;
    while (ids.has(`zen-${n}`)) n++;
    const name = $('#connectName').value.trim() || `OpenCode ${n}`;
    const r = await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ id: `zen-${n}`, name, provider: 'opencode-zen', apiKey: key, priority: n }),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 160));
    msg.textContent = `✓ Connected as ${name} — live in the pool.`;
    setTimeout(() => { closeConnect(); refresh(); }, 900);
  } catch (err) {
    msg.textContent = '✕ ' + String(err.message || err).slice(0, 160);
    $('#connectGo').disabled = false;
    $('#connectGo').textContent = 'Validate & connect';
  }
};

$('#proxyForm').onsubmit = async (e) => {
  e.preventDefault();
  const proxies = e.target.proxies.value.split('\n').map((s) => s.trim()).filter(Boolean);
  await jpost('/api/proxies', { proxies });
  loadProxies(); refresh();
};

// ---- proxy tabs ----
document.querySelectorAll('[data-ptab]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('[data-ptab]').forEach((b) => b.classList.toggle('on', b === btn));
    document.querySelectorAll('.ptab').forEach((p) => { p.hidden = p.id !== 'ptab-' + btn.dataset.ptab; });
    if (btn.dataset.ptab === 'scraper') { loadProviders(); refreshScrapeStatus(); }
  };
});

// ---- Add tab: test each line, add only the working ones ----
$('#proxyAddForm').onsubmit = async (e) => {
  e.preventDefault();
  const lines = e.target.proxies.value.split('\n').map((s) => s.trim()).filter(Boolean);
  const box = $('#addResult');
  if (!lines.length) { box.textContent = 'Paste at least one proxy.'; return; }
  box.textContent = `Testing ${lines.length}…`;
  try {
    const { results } = await (await api('/api/proxies/test', { method: 'POST', body: JSON.stringify({ proxies: lines }) })).json();
    const ok = results.filter((r) => r.ok).map((r) => r.proxy);
    const bad = results.filter((r) => !r.ok).map((r) => r.proxy);
    if (ok.length) {
      const cur = new Set(window._proxies || []);
      ok.forEach((p) => cur.add(p));
      await jpost('/api/proxies', { proxies: [...cur] });
    }
    box.innerHTML = `${ok.length} working added ✓` + (bad.length ? `<br>${bad.length} failed: ${bad.map(esc).join(', ')}` : '');
    e.target.reset();
    loadProxies(); refresh();
  } catch {
    box.textContent = 'Test failed — try again.';
  }
};

// ---- Scraper tab ----
async function loadProviders() {
  try {
    const { providers } = await (await api('/api/scraper/providers')).json();
    $('#providerList').innerHTML = providers.map((p) => `
      <li>
        <span><strong>${esc(p.name)}</strong> <span class="hint">${esc(p.url.slice(0, 60))}${p.url.length > 60 ? '…' : ''}</span>
        <span class="tag ${p.enabled ? 'ok' : ''}">${p.enabled ? 'on' : 'off'}</span></span>
        <span>
          <button class="btn" data-ptoggle="${p.id}">${p.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn danger" data-pdel="${p.id}">Remove</button>
        </span>
      </li>`).join('') || '<li class="hint">no providers</li>';
    $('#providerList').querySelectorAll('[data-ptoggle]').forEach((b) => b.onclick = async () => {
      const cur = providers.find((x) => x.id === b.dataset.ptoggle);
      await api('/api/scraper/providers/' + b.dataset.ptoggle, { method: 'PUT', body: JSON.stringify({ enabled: !cur.enabled }) });
      loadProviders();
    });
    $('#providerList').querySelectorAll('[data-pdel]').forEach((b) => b.onclick = async () => {
      if (!confirm('Remove this provider?')) return;
      await api('/api/scraper/providers/' + b.dataset.pdel, { method: 'DELETE' });
      loadProviders();
    });
  } catch { /* ignore */ }
}

$('#providerForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const r = await api('/api/scraper/providers', {
    method: 'POST',
    body: JSON.stringify({ name: f.name.value.trim(), url: f.url.value.trim(), format: f.format.value }),
  });
  if (r.ok) { f.reset(); loadProviders(); }
  else alert('Failed: ' + (await r.text()).slice(0, 200));
};

let scrapeTimer = null;
// Show last scrape info when opening the tab.
function renderScrapeProgress(p) {
  const wrap = $('#scrapeProgress');
  if (!p) {
    wrap.hidden = false;
    $('#scrapeBar').style.width = '2%';
    $('#scrapePhase').textContent = 'starting…';
    $('#scrapeLog').innerHTML = '';
    return;
  }
  wrap.hidden = false;
  let pct, phase;
  if (p.phase === 'fetching') {
    pct = p.providersTotal ? (p.providersDone / p.providersTotal) * 50 : 2;
    phase = `fetching proxy lists ${p.providersDone}/${p.providersTotal}${p.currentProvider ? ` · ${p.currentProvider}` : ''} · ${p.found} candidates`;
  } else {
    pct = 50 + (p.totalToTest ? (p.tested / p.totalToTest) * 50 : 0);
    phase = `testing proxies ${p.tested}/${p.totalToTest} · ${p.working} working so far`;
  }
  $('#scrapeBar').style.width = Math.min(99, Math.max(2, pct)).toFixed(1) + '%';
  $('#scrapePhase').textContent = phase;
  $('#scrapeLog').innerHTML = (p.providerResults || []).map((r) =>
    `<li><span>${r.ok ? '✓' : '✕'} ${esc(r.name)} <span class="hint">· ${r.found} found${r.error ? ` · ${esc(r.error)}` : ''}</span></span></li>`
  ).join('');
}

async function refreshScrapeStatus() {
  try {
    const s = await (await api('/api/scraper/status')).json();
    if (s.running) { $('#scrapeStatus').textContent = 'scraping…'; renderScrapeProgress(s.progress); return; }
    $('#scrapeProgress').hidden = true;
    if (s.lastRunAt) {
      const ago = Math.max(0, Math.round((Date.now() - s.lastRunAt) / 60000));
      const when = ago < 1 ? 'just now' : ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ${ago % 60}m ago`;
      $('#scrapeStatus').textContent = `last run ${when}${s.lastRunAuto ? ' (scheduled)' : ''}${s.result ? ` — ${s.result.working.length} working` : ''}`;
    }
  } catch { /* ignore */ }
}
$('#scrapeBtn').onclick = async () => {
  const r = await api('/api/scraper/run', { method: 'POST' });
  if (!r.ok) { $('#scrapeStatus').textContent = 'already running'; return; }
  $('#scrapeBtn').disabled = true;
  $('#scrapeStatus').textContent = 'scraping…';
  $('#scrapeResult').innerHTML = '';
  clearInterval(scrapeTimer);
  scrapeTimer = setInterval(async () => {
    try {
      const s = await (await api('/api/scraper/status')).json();
      if (s.running) { $('#scrapeStatus').textContent = 'scraping…'; renderScrapeProgress(s.progress); return; }
      clearInterval(scrapeTimer);
      $('#scrapeBtn').disabled = false;
      $('#scrapeProgress').hidden = true;
      const res = s.result;
      if (!res) { $('#scrapeStatus').textContent = 'failed'; return; }
      const secs = ((res.finishedAt - res.startedAt) / 1000).toFixed(1);
      $('#scrapeStatus').textContent = `done in ${secs}s`;
      $('#scrapeResult').innerHTML = `
        <div class="cards">
          <div class="card"><div class="k">Found</div><div class="v">${res.found}</div></div>
          <div class="card"><div class="k">Tested</div><div class="v">${res.tested}</div></div>
          <div class="card"><div class="k">Working</div><div class="v">${res.working.length}</div></div>
        </div>
        <ul class="plist">` + res.providers.map((p) => `
          <li><span>${esc(p.name)} ${p.ok ? `<span class="tag ok">${p.found} found</span>` : `<span class="tag bad">failed</span>`}</span>
          ${p.error ? `<span class="hint">${esc(p.error)}</span>` : ''}</li>`).join('') + `</ul>`;
      loadProxies(); refresh();
    } catch { /* keep polling */ }
  }, 3000);
};

$('#settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, body = {};
  for (const k of ['upstreamBase', 'maxRetries', 'retryBaseMs', 'retryMaxMs', 'defaultCooldownMs', 'requestTimeoutMs', 'port', 'proxyHealthIntervalMs', 'quota5hLimit', 'tokenSaverMaxChars', 'autoScrapeIntervalHours', 'queueMaxWaitMs', 'accountConcurrency', 'proxyAutoDropFails', 'errorSpikeThreshold', 'errorSpikeWindowMin', 'errorSpikeMinRequests', 'logMaxMb', 'logKeep', 'shutdownDrainMs']) {
    if (f[k].value !== '') body[k] = f[k].type === 'number' ? Number(f[k].value) : f[k].value;
  }
  // logFile is always sent (empty clears it) so file logging can be turned off.
  if (f.logFile) body.logFile = f.logFile.value.trim();
  body.proxyHealthCheck = !!f.proxyHealthCheck.checked;
  body.tokenSaver = !!f.tokenSaver.checked;
  body.autoScrape = !!f.autoScrape.checked;
  if (f.routingStrategy && f.routingStrategy.value) body.routingStrategy = f.routingStrategy.value;
  if (f.alertWebhookUrl.value) body.alertWebhookUrl = f.alertWebhookUrl.value;
  if (f.modelFallbacks && f.modelFallbacks.value.trim()) {
    try {
      body.modelFallbacks = JSON.parse(f.modelFallbacks.value);
    } catch {
      $('#settingsMsg').textContent = 'Save failed: model fallbacks is not valid JSON.';
      return;
    }
  }
  if (f.modelTimeouts && f.modelTimeouts.value.trim()) {
    try {
      body.modelTimeouts = JSON.parse(f.modelTimeouts.value);
    } catch {
      $('#settingsMsg').textContent = 'Save failed: model timeouts is not valid JSON.';
      return;
    }
  }
  if (f.egressFamily && f.egressFamily.value) body.egressFamily = f.egressFamily.value;
  if (f.adminToken.value) { body.adminToken = f.adminToken.value; adminToken = f.adminToken.value; localStorage.setItem('om_admin_token', adminToken); }
  if (f.clientTokens && f.clientTokens.value.trim()) body.clientTokens = f.clientTokens.value;
  if (f.clearClientTokens && f.clearClientTokens.checked) body.clearClientTokens = true;
  const r = await jpost('/api/settings', body);
  const d = await r.json().catch(() => ({}));
  $('#settingsMsg').textContent = r.ok ? '✓ Saved' + (d.restartRequired ? ' — restart required for the port change.' : '') : 'Save failed.';
  f.adminToken.value = '';
  f.alertWebhookUrl.value = '';
  if (f.clientTokens) f.clientTokens.value = '';
  if (f.clearClientTokens) f.clearClientTokens.checked = false;
  refresh();
};

$('#btnCopy').onclick = () => {
  navigator.clipboard.writeText($('#opencodeSnippet').textContent).then(() => {
    $('#btnCopy').textContent = '✓ Copied';
    setTimeout(() => $('#btnCopy').textContent = 'Copy snippet', 1500);
  });
};

// ---- Providers ----
let upProviders = [];
async function loadUpProviders() {
  try {
    const { providers } = await (await api('/api/providers')).json();
    upProviders = providers || [];
    $('#providerUpList').innerHTML = upProviders.map((p) => `
      <li>
        <span><strong>${esc(p.name)}</strong> <span class="hint">${esc(p.baseUrl)}</span><br>
        <span class="hint">models: ${esc((p.models || []).join(', '))}</span>
        ${p.protocol === 'qwen-web' ? '<span class="tag">qwen-web</span>' : ''}
        <span class="tag ${p.enabled ? 'ok' : ''}">${p.enabled ? 'on' : 'off'}</span></span>
        <span class="row-btns">
          <button class="btn" data-ptest="${esc(p.id)}">Test</button>
          <button class="btn" data-ptoggle="${esc(p.id)}">${p.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn danger" data-pdel="${esc(p.id)}">Remove</button>
        </span>
      </li>`).join('') || '<li class="hint">no providers</li>';
    $('#providerUpList').querySelectorAll('[data-ptoggle]').forEach((b) => b.onclick = async () => {
      const cur = upProviders.find((x) => x.id === b.dataset.ptoggle);
      await api('/api/providers/' + encodeURIComponent(cur.id), { method: 'PUT', body: JSON.stringify({ ...cur, enabled: !cur.enabled }) });
      loadUpProviders();
    });
    $('#providerUpList').querySelectorAll('[data-pdel]').forEach((b) => b.onclick = async () => {
      if (!confirm(`Remove provider ${b.dataset.pdel}? Its accounts will stop routing.`)) return;
      const r = await api('/api/providers/' + encodeURIComponent(b.dataset.pdel), { method: 'DELETE' });
      if (!r.ok) alert('Failed: ' + (await r.text()).slice(0, 160));
      loadUpProviders();
    });
    $('#providerUpList').querySelectorAll('[data-ptest]').forEach((b) => b.onclick = async () => {
      b.disabled = true; b.textContent = '…';
      try {
        const t = await (await api('/api/providers/' + encodeURIComponent(b.dataset.ptest) + '/test', { method: 'POST' })).json();
        b.textContent = t.ok ? `✓ ${t.models} models` : `✕ ${t.error || 'failed'}`;
      } catch { b.textContent = '✕ error'; }
      setTimeout(() => { b.disabled = false; b.textContent = 'Test'; }, 2500);
    });
    // account form provider dropdowns
    const sel = $('#accountProvider');
    if (sel) sel.innerHTML = upProviders.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const esel = $('#editAccountProvider');
    if (esel) esel.innerHTML = upProviders.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    if (window._lastStatus) renderProviderCards();
  } catch { /* ignore */ }
}

$('#providerProtocol').onchange = (e) => {
  $('#qwenOpts').hidden = e.target.value !== 'qwen-web';
};

$('#providerForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, msg = $('#providerMsg');
  const payload = {
    id: f.id.value.trim(), name: f.name.value.trim(),
    baseUrl: f.baseUrl.value.trim(),
    models: f.models.value.split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (f.protocol.value === 'qwen-web') {
    payload.protocol = 'qwen-web';
    const qwen = {};
    if (f.qwenDefaultModel.value.trim()) qwen.defaultModel = f.qwenDefaultModel.value.trim();
    if (f.qwenModelMap.value.trim()) {
      try {
        qwen.modelMap = JSON.parse(f.qwenModelMap.value);
      } catch {
        msg.textContent = '✕ model map is not valid JSON';
        return;
      }
    }
    payload.qwen = qwen;
  }
  const r = await api('/api/providers', { method: 'POST', body: JSON.stringify(payload) });
  if (r.ok) { f.reset(); $('#qwenOpts').hidden = true; msg.textContent = '✓ Provider added.'; loadUpProviders(); }
  else msg.textContent = '✕ ' + (await r.text()).slice(0, 200);
};

$('#qwenPresetBtn').onclick = async () => {
  const msg = $('#providerMsg');
  const r = await api('/api/providers/preset/qwen', { method: 'POST' });
  if (r.ok) {
    const j = await r.json().catch(() => ({}));
    msg.textContent = j.upgraded ? '✓ Qwen provider upgraded to the built-in native version.' : '✓ Qwen provider added — now connect your Qwen account.';
  } else {
    msg.textContent = '✕ ' + (await r.text()).slice(0, 200);
  }
  loadUpProviders();
};

// ---- Connect Qwen account ----
document.querySelectorAll('[data-qtab]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('[data-qtab]').forEach((b) => b.classList.toggle('on', b === btn));
    $('#qtab-signin').hidden = btn.dataset.qtab !== 'signin';
    $('#qtab-token').hidden = btn.dataset.qtab !== 'token';
    $('#qwenConnectMsg').textContent = '';
  };
});
$('#qwenConnectBtn').onclick = () => {
  $('#qwenConnectMsg').textContent = '';
  $('#qwenConnectForm').reset();
  const sf = $('#qwenSigninForm');
  if (sf) sf.reset();
  $('#qwenConnectModal').hidden = false;
};
$('#qwenConnectClose').onclick = () => { $('#qwenConnectModal').hidden = true; };

async function sha256Hex(text) {
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return null; // non-secure context — server will hash instead
}

$('#qwenSigninForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, msg = $('#qwenConnectMsg');
  const email = f.email.value.trim();
  const password = f.password.value;
  if (!email || !password) { msg.textContent = '✕ email and password are required'; return; }
  msg.textContent = 'Signing in…';
  try {
    const hash = await sha256Hex(password);
    const payload = hash
      ? { email, passwordHash: hash, name: f.name.value.trim() }
      : { email, password, name: f.name.value.trim() }; // server hashes
    const r = await api('/api/accounts/qwen-login', { method: 'POST', body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { msg.textContent = '✕ ' + (j.error || 'sign-in failed'); return; }
    msg.textContent = '✓ Qwen account connected.';
    $('#qwenConnectModal').hidden = true;
    loadUpProviders();
    refresh();
  } catch (err) {
    msg.textContent = '✕ ' + String(err && err.message || err).slice(0, 200);
  }
};

$('#qwenConnectForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, msg = $('#qwenConnectMsg');
  const credential = f.credential.value.trim();
  if (!credential) { msg.textContent = '✕ paste your Qwen token first'; return; }
  msg.textContent = 'Validating token…';
  try {
    const v = await (await api('/api/accounts/validate-qwen', {
      method: 'POST', body: JSON.stringify({ credential }),
    })).json();
    if (!v.ok) { msg.textContent = '✕ ' + (v.error || 'token rejected'); return; }
    // Make sure the Qwen provider exists (the sign-in tab does this server-side;
    // the paste-token tab must do it here). 409 = already there, ignore it.
    msg.textContent = 'Setting up Qwen provider…';
    const preset = await api('/api/providers/preset/qwen', { method: 'POST' });
    if (!preset.ok && preset.status !== 409) {
      msg.textContent = '✕ could not add Qwen provider: ' + (await preset.text()).slice(0, 160);
      return;
    }
    const list = await (await api('/api/accounts')).json();
    const ids = new Set((list.accounts || []).map((a) => a.id));
    let n = 1;
    while (ids.has(`qwen-${n}`)) n++;
    const r = await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        id: `qwen-${n}`, name: f.name.value.trim() || `Qwen ${n}`,
        provider: 'qwen', apiKey: credential, priority: Number(f.priority.value) || n,
      }),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 160));
    msg.textContent = '✓ Qwen account connected.';
    $('#qwenConnectModal').hidden = true;
    refresh();
  } catch (err) {
    msg.textContent = '✕ ' + String(err && err.message || err).slice(0, 200);
  }
};

// ---- Provider cards (Accounts page): click a card for its detail page ----
function providerModelList(p) {
  if (p.protocol === 'qwen-web') {
    const map = (p.qwen && p.qwen.modelMap) || {};
    const names = [p.qwen && p.qwen.defaultModel, ...Object.keys(map)].filter(Boolean);
    return [...new Set(names)];
  }
  return p.models || [];
}

function providerCardRows(accounts, s) {
  const globalLimit = s.quota5hLimit || 200;
  return accounts.map((a) => {
    const resetBtn = a.state === 'invalid' ? `<button class="btn" data-reset="${esc(a.id)}">Reset</button>` : '';
    const limit = a.quotaLimit || globalLimit;
    const usage = a.usage5h || 0;
    return `<tr><td><code>${esc(a.id)}</code><div class="hint">${esc(a.name)}</div></td>` +
      `<td>P${a.priority}</td>` +
      `<td><span class="${usage >= limit ? 'tag bad' : usage >= limit * 0.9 ? 'tag warn' : ''}">${usage}/${limit}</span></td>` +
      `<td>${a.avgLatencyMs ? a.avgLatencyMs + '<small> ms</small>' : '<span class="hint">—</span>'}</td>` +
      `<td><span class="badge ${a.state}">${a.state.replace('_', ' ')}</span></td>` +
      `<td>${fmtMs(a.cooldownEndsInMs)}</td>` +
      `<td><div class="row-btns"><button class="btn danger" data-del="${esc(a.id)}">Remove</button>` +
      `<button class="btn" data-edit="${esc(a.id)}">Edit</button>${resetBtn}</div></td></tr>`;
  }).join('');
}

function renderProviderCards() {
  const el = $('#providerCards');
  const s = window._lastStatus;
  if (!el || !s) return;
  const accounts = s.accounts || [];
  const cards = upProviders.map((p) => {
    const accs = accounts.filter((a) => a.provider === p.id);
    const active = accs.filter((a) => a.state === 'active').length;
    const models = providerModelList(p);
    const connectBtn = p.id === 'qwen'
      ? `<button class="btn primary" data-qconnect>Connect Qwen account</button>`
      : p.id === 'opencode-zen'
        ? `<button class="btn primary" data-oconnect>Connect OpenCode account</button>`
        : '';
    return `<div class="pcard">
      <div class="pcard-head" data-popen="${esc(p.id)}">
        <div><h3>${esc(p.name)}
          ${p.protocol === 'qwen-web' ? '<span class="tag">qwen-web</span>' : ''}
          <span class="tag ${p.enabled ? 'ok' : ''}">${p.enabled ? 'on' : 'off'}</span></h3>
          <div class="pcard-count">${accs.length} account${accs.length === 1 ? '' : 's'}${active !== accs.length ? ` · ${active} active` : ''} · ${models.length} models</div>
          <div class="hint">${esc(p.baseUrl || '')}</div>
        </div>
        <div class="row-btns" data-pactions="${esc(p.id)}">
          <button class="btn" data-ptest="${esc(p.id)}">Test</button>
          ${connectBtn}
          <span class="pcard-go">→</span>
        </div>
      </div>
    </div>`;
  }).join('');

  // Ghost card: offer the built-in Qwen provider when it isn't added yet.
  const ghost = upProviders.some((p) => p.id === 'qwen') ? '' :
    `<div class="pcard ghost">
      <div class="pcard-head"><div><h3>Qwen <span class="tag">qwen-web</span> <span class="tag">built-in</span></h3>
      <div class="pcard-count">free Qwen chat — no separate deployment</div></div>
      <div class="row-btns"><button class="btn primary" data-qpreset>Add Qwen provider</button></div></div>
    </div>`;

  el.innerHTML = cards + ghost || '<div class="hint">no providers configured</div>';

  el.querySelectorAll('[data-popen]').forEach((h) => h.onclick = (e) => {
    if (e.target.closest('[data-pactions]')) return;
    showProviderDetail(h.dataset.popen);
  });
  el.querySelectorAll('[data-ptest]').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true; b.textContent = '…';
    try {
      const t = await (await api('/api/providers/' + encodeURIComponent(b.dataset.ptest) + '/test', { method: 'POST' })).json();
      b.textContent = t.ok ? `✓ ${t.models} models` : `✕ ${t.error || 'failed'}`;
    } catch { b.textContent = '✕ error'; }
    setTimeout(() => { b.disabled = false; b.textContent = 'Test'; }, 2500);
  });
  el.querySelectorAll('[data-qconnect]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    $('#qwenConnectMsg').textContent = '';
    $('#qwenConnectModal').hidden = false;
  });
  el.querySelectorAll('[data-oconnect]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openConnect(); });
  el.querySelectorAll('[data-qpreset]').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true;
    const r = await api('/api/providers/preset/qwen', { method: 'POST' });
    if (r.ok || r.status === 409) { await loadUpProviders(); renderProviderCards(); }
    else { b.textContent = '✕ failed'; setTimeout(() => { b.disabled = false; b.textContent = 'Add Qwen provider'; }, 2000); }
  });
}

// ---- Provider detail page ----
async function showProviderDetail(id) {
  const p = upProviders.find((x) => x.id === id);
  if (!p) return;
  const el = $('#providerDetail');
  const s = window._lastStatus || { accounts: [], quota5hLimit: 200 };
  const accs = (s.accounts || []).filter((a) => a.provider === id);
  const active = accs.filter((a) => a.state === 'active').length;
  const usage = accs.reduce((n, a) => n + (a.usage5h || 0), 0);
  const models = providerModelList(p);
  const connectBtn = p.id === 'qwen'
    ? `<button class="btn primary" id="pdQConnect">Connect Qwen account</button>`
    : p.id === 'opencode-zen'
      ? `<button class="btn primary" id="pdOConnect">Connect OpenCode account</button>`
      : '';
  el.innerHTML = `
    <button class="btn" id="pdBack">← All providers</button>
    <div class="panel-head" style="margin-top:14px"><h3>${esc(p.name)}
      ${p.protocol === 'qwen-web' ? '<span class="tag">qwen-web</span>' : '<span class="tag">openai</span>'}
      <span class="tag ${p.enabled ? 'ok' : ''}">${p.enabled ? 'on' : 'off'}</span></h3>
      <div class="row-btns">
        <button class="btn" id="pdTest">Test</button>
        <button class="btn" id="pdToggle">${p.enabled ? 'Disable' : 'Enable'}</button>
        ${connectBtn}
      </div></div>
    <div class="hint" style="margin-bottom:14px"><code>${esc(p.baseUrl || '')}</code></div>
    <div class="cards" id="pdStats"></div>
    <h4 class="sub">Models <span class="hint">shared by all ${esc(p.name)} accounts</span></h4>
    <div class="models">${models.map((m) => `<span class="tag">${esc(m)}</span>`).join('') || '<span class="hint">—</span>'}</div>
    <h4 class="sub">Accounts <span class="hint">${accs.length}</span></h4>
    ${accs.length ? `<table class="tbl"><thead><tr><th>ID</th><th>Pri</th><th>5h usage</th><th>Latency</th><th>State</th><th>Cooldown</th><th></th></tr></thead>
      <tbody>${providerCardRows(accs, s)}</tbody></table>`
      : '<div class="hint">no accounts yet — connect one above</div>'}
    <h4 class="sub">Recent requests <span class="hint">24h</span></h4>
    <div id="pdHealth"><span class="hint">loading…</span></div>
    <div id="pdReqs"><span class="hint">loading…</span></div>`;

  $('#pdBack').onclick = () => showSection('accounts');
  $('#pdTest').onclick = async (e) => {
    const b = e.target; b.disabled = true; b.textContent = '…';
    try {
      const t = await (await api('/api/providers/' + encodeURIComponent(p.id) + '/test', { method: 'POST' })).json();
      b.textContent = t.ok ? `✓ ${t.models} models` : `✕ ${t.error || 'failed'}`;
    } catch { b.textContent = '✕ error'; }
    setTimeout(() => { b.disabled = false; b.textContent = 'Test'; }, 2500);
  };
  $('#pdToggle').onclick = async () => {
    await api('/api/providers/' + encodeURIComponent(p.id), { method: 'PUT', body: JSON.stringify({ ...p, enabled: !p.enabled }) });
    await loadUpProviders();
    showProviderDetail(id);
  };
  const q = $('#pdQConnect');
  if (q) q.onclick = () => { $('#qwenConnectMsg').textContent = ''; $('#qwenConnectModal').hidden = false; };
  const o = $('#pdOConnect');
  if (o) o.onclick = () => openConnect();
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm(`Remove account ${b.dataset.del}?`)) return;
    await jdel('/api/accounts/' + encodeURIComponent(b.dataset.del));
    refresh(); showProviderDetail(id);
  });
  el.querySelectorAll('[data-reset]').forEach((b) => b.onclick = async () => {
    await api('/api/accounts/' + encodeURIComponent(b.dataset.reset) + '/reset', { method: 'POST' });
    refresh(); showProviderDetail(id);
  });
  el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openAccountEdit(b.dataset.edit));

  showSection('provider', p.name);

  // Health + recent requests for this provider.
  try {
    const { providers } = await (await api('/api/metrics/providers?hours=24')).json();
    const h = (providers || []).find((x) => x.provider === id);
    const cards = [
      ['Accounts', `${accs.length}`],
      ['Active', `${active}`],
      ['5h usage', `${usage}`],
      ['Success 24h', h ? `${h.successRate}%` : '—'],
      ['Avg latency', h ? `${h.avgLatencyMs}<small> ms</small>` : '—'],
      ['Requests 24h', h ? `${h.requests}` : '0'],
    ];
    $('#pdStats').innerHTML = cards.map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
    $('#pdHealth').innerHTML = h && h.lastErrorAt
      ? `<div class="hint">last error: ${h.lastErrorStatus} · ${new Date(h.lastErrorAt).toLocaleString()}</div>` : '';
  } catch { $('#pdStats').innerHTML = ''; $('#pdHealth').innerHTML = ''; }
  try {
    const { requests } = await (await api('/api/requests?limit=50')).json();
    const rows = (requests || []).filter((r) => r.provider === id).slice(0, 15).map((r) => {
      const time = new Date(r.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const cls = r.status >= 500 ? 'tag bad' : r.status >= 400 ? 'tag warn' : 'tag ok';
      return `<tr><td>${time}</td><td><code>${esc(r.model || '—')}</code></td><td><code>${esc(r.accountId)}</code></td>` +
        `<td><span class="${cls}">${r.status}</span></td><td>${r.latencyMs}<small> ms</small></td></tr>`;
    }).join('');
    $('#pdReqs').innerHTML = rows
      ? `<table class="tbl"><thead><tr><th>Time</th><th>Model</th><th>Account</th><th>Status</th><th>Latency</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="hint">no requests yet</div>';
  } catch { $('#pdReqs').innerHTML = ''; }
}

// ---- Account edit modal ----
function openAccountEdit(id) {
  const a = (window._lastStatus?.accounts || []).find((x) => x.id === id);
  if (!a) return;
  const f = $('#accountEditForm');
  $('#editAccountId').textContent = a.id;
  f.name.value = a.name || '';
  if (f.provider) f.provider.value = a.provider || '';
  f.apiKey.value = '';
  f.clearApiKey.checked = false;
  f.priority.value = a.priority ?? 1;
  f.cooldownPeriod.value = a.cooldownPeriod ?? '';
  f.baseUrl.value = a.baseUrl ?? '';
  f.quotaLimit.value = a.quotaLimit ?? '';
  $('#accountEditMsg').textContent = '';
  $('#accountEditModal').hidden = false;
}

$('#accountEditClose').onclick = () => { $('#accountEditModal').hidden = true; };

$('#accountEditForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, msg = $('#accountEditMsg');
  const id = $('#editAccountId').textContent;
  const body = {
    name: f.name.value.trim(),
    provider: f.provider.value,
    apiKey: f.apiKey.value,
    clearApiKey: !!f.clearApiKey.checked,
    priority: Number(f.priority.value) || 1,
  };
  if (f.cooldownPeriod.value !== '') body.cooldownPeriod = Number(f.cooldownPeriod.value);
  if (f.baseUrl.value.trim() !== '') body.baseUrl = f.baseUrl.value.trim();
  if (f.quotaLimit.value !== '') body.quotaLimit = Number(f.quotaLimit.value);
  const r = await api('/api/accounts/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) });
  if (r.ok) {
    msg.textContent = '✓ Saved.';
    $('#accountEditModal').hidden = true;
    refresh();
  } else {
    msg.textContent = '✕ ' + (await r.text()).slice(0, 200);
  }
};

// ---- Manual account add ----
$('#accountForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, msg = $('#accountMsg');
  try {
    const list = await (await api('/api/accounts')).json();
    const ids = new Set((list.accounts || []).map((a) => a.id));
    const prefix = f.provider.value === 'opencode-zen' ? 'zen' : f.provider.value.replace(/[^a-z0-9]/gi, '');
    let n = 1;
    while (ids.has(`${prefix}-${n}`)) n++;
    const r = await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        id: `${prefix}-${n}`, name: f.name.value.trim() || `${f.provider.value} ${n}`,
        provider: f.provider.value, apiKey: f.apiKey.value, priority: Number(f.priority.value) || n,
        cooldownPeriod: f.cooldownPeriod.value !== '' ? Number(f.cooldownPeriod.value) : undefined,
        baseUrl: f.baseUrl.value.trim() || undefined,
        quotaLimit: f.quotaLimit.value !== '' ? Number(f.quotaLimit.value) : undefined,
      }),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 160));
    msg.textContent = `✓ Account added to ${f.provider.value}.`;
    f.reset();
    refresh();
  } catch (err) {
    msg.textContent = '✕ ' + String(err.message || err).slice(0, 160);
  }
};

loadProxies(); loadSettings(); loadUpProviders(); refresh();
setInterval(refresh, 3000);
