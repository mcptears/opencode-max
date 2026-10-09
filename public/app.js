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
  const tb = $('#accountsTbl tbody');
  tb.innerHTML = accountRows(s, true) || '<tr><td colspan="9" class="hint">no accounts configured</td></tr>';
  tb.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm(`Remove account ${b.dataset.del}?`)) return;
    await jdel('/api/accounts/' + encodeURIComponent(b.dataset.del));
    refresh();
  });
  tb.querySelectorAll('[data-reset]').forEach((b) => b.onclick = async () => {
    await api('/api/accounts/' + encodeURIComponent(b.dataset.reset) + '/reset', { method: 'POST' });
    refresh();
  });
  tb.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openAccountEdit(b.dataset.edit));

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
$('#connectBtn').onclick = openConnect;
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
async function refreshScrapeStatus() {
  try {
    const s = await (await api('/api/scraper/status')).json();
    if (s.running) { $('#scrapeStatus').textContent = 'scraping…'; return; }
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
      if (s.running) return;
      clearInterval(scrapeTimer);
      $('#scrapeBtn').disabled = false;
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
  } catch { /* ignore */ }
}

$('#providerForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, msg = $('#providerMsg');
  const r = await api('/api/providers', {
    method: 'POST',
    body: JSON.stringify({
      id: f.id.value.trim(), name: f.name.value.trim(),
      baseUrl: f.baseUrl.value.trim(),
      models: f.models.value.split(',').map((s) => s.trim()).filter(Boolean),
    }),
  });
  if (r.ok) { f.reset(); msg.textContent = '✓ Provider added.'; loadUpProviders(); }
  else msg.textContent = '✕ ' + (await r.text()).slice(0, 200);
};

$('#qwenPresetBtn').onclick = async () => {
  const msg = $('#providerMsg');
  const r = await api('/api/providers/preset/qwen', { method: 'POST' });
  msg.textContent = r.ok ? '✓ Qwen provider added — point your qwen2api at :8765.' : '✕ ' + (await r.text()).slice(0, 200);
  loadUpProviders();
};

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
