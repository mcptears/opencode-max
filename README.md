# 🚀 opencode-max

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-3178C6.svg)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-30%20passing-brightgreen.svg)](#-testing)

A unified proxy wrapper for **OpenCode Zen** that combines **🔄 IP rotation** with **🔑 multi-account API key management** in a single Node.js/TypeScript + Express server.

> Point OpenCode at `http://127.0.0.1:8080/v1` — opencode-max handles tokens, IPs, retries and quota so you never hit a wall mid-session.

## ✨ Feature highlights

| | Feature | What it does |
|---|---|---|
| 🔑 | **Multi-account pool** | Priority-ordered API keys with auto-reactivating cooldowns |
| 🔄 | **IP rotation** | Round-robin egress proxy pool — a real IP change per rotation |
| 🩺 | **Dead-key detection** | `401`/invalid keys parked instantly, one-click reset in dashboard |
| 💓 | **Proxy health checks** | Dead proxies auto-skipped until they recover |
| 🌐 | **IPv4/IPv6 rotation** | Alternates families on dual-stack hosts — separate Zen buckets |
| 📊 | **Quota tracking** | Per-account rolling 5h window in SQLite; steers *before* the 429 |
| 📈 | **Metrics history** | Request log + event feed persisted, 24h traffic chart |
| ✂️ | **Token saver** | Compresses bloated `tool_result` payloads (saves ~20–40% tokens) |
| 🖥️ | **Dashboard** | Beautiful admin panel — accounts, proxies, settings, events |
| 🔗 | **Connect flow** | Link → sign in anywhere → paste key → validated & added, no JSON |
| 🧪 | **Tested** | 69 unit tests, `npm test` |
| 🐳 | **Docker** | Multi-stage build + compose, one command deploy |
| 🕷️ | **Proxy scraper** | Scrapes free proxy lists, tests candidates, adds working ones |
| 🔌 | **Multi-provider** | Route by model to any OpenAI-compatible upstream (Zen, qwen2api, …) |
| 🛟 | **Cross-provider failover** | Primary down? Requests spill over to the next eligible provider |
| ⏰ | **Auto-scrape** | Re-scrapes free proxies on a schedule to keep the pool fresh |
| ⚡ | **Latency routing** | Pick the fastest healthy account, not just P1 first |
| ⏳ | **Request queue** | Waits for a cooling account instead of 503ing |
| 🔔 | **Down alerts** | Webhook ping on dead keys / pool exhaustion (Telegram-ready) |
| 📊 | **Per-model stats** | Dashboard breakdown: requests, errors, latency per model |

## ⚙️ How it works

```
[OpenCode client] ──HTTP──> [opencode-max :8080] ──HTTPS (+proxy)──> https://opencode.ai/zen/v1
                              │
                              ├─ accounts.json  → priority token pool (P1 → P2 → …)
                              ├─ proxies.json   → round-robin egress proxy pool
                              └─ ses_*          → session id, rotated on every 429
```

**Every outgoing request:**

1. 🔑 Takes the highest-priority **active** token and attaches it as `Authorization: Bearer <token>`
2. 🧹 Strips identity/telemetry artifacts — hop-by-hop headers, cookies, spoofed `x-real-ip`/`x-forwarded-for` hints, telemetry blobs, stale `session_id` GUIDs
3. 🌐 Routes through the selected egress proxy (or direct if none configured)

**On 429 / quota / transient 5xx:**

| Step | Action |
|------|--------|
| 1️⃣ | Token parked for its `cooldownPeriod` (auto-reactivates) |
| 2️⃣ | Egress IP rotated to the next proxy |
| 3️⃣ | Fresh `ses_*` session id minted |
| 4️⃣ | Transparent retry with exponential backoff + jitter |

> Zen keys its rate-limit bucket on the **raw egress IP** — so a genuine egress change, not header spoofing, is what resets the bucket.

## 🩺 Dead-key detection

A `401`, or a `403` whose body looks like an invalid key (rather than quota), parks the key immediately as `invalid` — no pointless retries or IP rotations. It stays out of rotation until you fix it and hit **Reset** in the dashboard (`POST /api/accounts/:id/reset`).

## 💓 Proxy health checks

Proxies are probed periodically (default every 60s, `PROXY_HEALTH_INTERVAL_MS`) through their own dispatcher. A proxy that fails twice in a row is marked **down** and skipped until it recovers; transitions are logged as events. Toggle with `PROXY_HEALTH_CHECK=0` or the dashboard checkbox. Credentials are redacted everywhere.

## 🌐 IPv4/IPv6 family rotation

Zen treats IPv4 and IPv6 as **separate** rate-limit buckets. With no proxies configured, opencode-max detects dual-stack at startup and alternates the connection family on every rotation in `auto` mode — effectively doubling the quota. Pin with `EGRESS_FAMILY=4|6|auto`.

## 📊 Per-account quota tracking

Every upstream attempt is counted per account in a rolling **5h window**, persisted in embedded SQLite (`data/opencode-max.db`, survives restarts). The pool steers *away* from accounts before they hit the limit:

- Accounts at/over `QUOTA_5H_LIMIT` (default `200`) are excluded until the window slides
- Among equal-priority accounts, the least-used one is picked first
- Dashboard shows live `usage/limit` with a ⚠️ warning state at 90%

## 📈 Metrics history

Request log (status, latency, model) and the event feed persist in SQLite and survive restarts — the feed is backfilled on boot. `GET /api/metrics/history?hours=24` returns hourly buckets, rendered as a traffic chart on the Overview page (🟠 dots mark hours with rate limits). 30 days retained.

## ✂️ Token saver

Agentic loops stuff tens of thousands of characters of diffs/logs into `tool_result` payloads. Before forwarding, oversized results are compressed — blank runs collapsed, repeated log lines deduped, the rest middle-truncated keeping head + tail. Only tool-result content is ever touched. Estimated tokens saved (chars/4) accumulate on the dashboard. Toggle with `TOKEN_SAVER=0`.

## 🔗 Connect flow — no JSON editing

The dashboard's **Connect OpenCode account** button opens a guided modal:

1. 📋 Copy the opencode.ai link — open it in any browser or profile
2. 🔐 Sign in and create an API key
3. 📥 Paste it back — validated live with a 1-token ping (bad keys rejected before anything is saved)
4. ✅ Added to the pool instantly with an auto id

The server also boots with an empty pool, so connecting from the dashboard is the first-run onboarding path.

## 🕷️ Proxy scraper

The Proxies section has a **Scraper** tab that fills your pool from free proxy lists:

1. **Providers** — 7 curated sources ship built-in (ProxyScrape, TheSpeedX, monosans, GeoNode, spys.one, free-proxy-list.net, ProxyNova). Enable/disable them, or **add your own** (text `ip:port` lists, GeoNode JSON, spys.one-style pages, free-proxy-list.net tables, or ProxyNova pages).
2. **Scrape now** — fetches every enabled provider, dedupes candidates, and tests up to 120 of them with 8-way concurrency.
3. **Working proxies join the pool automatically** — the health checker keeps weeding out the flaky ones afterwards.

There's also an **Add** tab: paste proxies, each line is tested before it joins the pool — dead ones are listed and skipped.

```bash
# API
GET    /api/scraper/providers      # list providers
POST   /api/scraper/providers      # add one { name, url, format }
PUT    /api/scraper/providers/:id  # edit / enable / disable
DELETE /api/scraper/providers/:id
POST   /api/scraper/run            # start a scrape (async)
GET    /api/scraper/status         # poll progress / result
POST   /api/proxies/test           # test proxies without adding
```

## 🔌 Multi-provider routing

opencode-max can front **multiple OpenAI-compatible upstreams** and route by model name — 9router-style. Each provider has its own base URL, model patterns (globs), account pool and on/off switch. Specific patterns beat the `*` catch-all, so `qwen*` routes to Qwen while everything else falls through to Zen.

Manage them in the dashboard's **Providers** section (add, test connection, enable/disable, remove), or via API:

```bash
GET    /api/providers              # list
POST   /api/providers              # { id, name, baseUrl, models[], enabled }
PUT    /api/providers/:id
DELETE /api/providers/:id
POST   /api/providers/:id/test     # live /models check
```

`GET /v1/models` aggregates the model catalogs of all enabled providers. Accounts belong to a provider via their `provider` field; the base URL resolves as `account.baseUrl` → `provider.baseUrl` → `UPSTREAM_BASE`.

### Qwen via qwen2api

1. Deploy [qwen2api](https://github.com/smanx/qwen2api) yourself (Docker, Vercel, Netlify or Cloudflare Workers — see its README), listening on port `8765`.
2. In the dashboard, hit **Add Qwen (qwen2api) provider** — or `POST /api/providers/preset/qwen`.
3. No account needed: if your qwen2api has no `API_TOKENS` set, requests forward without a key. If it does, add an account on the `qwen` provider with the token.

Then just ask for a Qwen model — `qwen-max`, `qwen-plus`, … — and it routes there, with the same proxy rotation, retries and session handling as Zen.

### Cross-provider failover

When a provider's accounts are all exhausted (or its upstream is down), the request automatically spills over to the next eligible provider instead of returning 503 — a provider is eligible if its model patterns match the request or it's a catch-all. Failovers are counted on the Overview dashboard and logged in the event feed.

### Scheduled proxy scraping

The scraper can run itself: enable **Auto-scrape** in Settings (or `AUTO_SCRAPE=1`) and set the interval (`AUTO_SCRAPE_INTERVAL_HOURS`, default 6). The first run fires 60s after boot, then on schedule; toggle and interval changes apply live without restart. The scraper tab shows when the last run happened and whether it was scheduled.

### Latency-based routing

Every successful request feeds an exponential moving average of latency per account (shown in the accounts table). Set **Routing strategy** to `latency` (or `ROUTING_STRATEGY=latency`) and the pool picks the fastest-known account instead of strict priority order — new accounts are tried first so they get a measurement. Default `priority` keeps P1-first with latency as the tiebreaker.

### Request queue

When every account is cooling down, requests now wait for the soonest cooldown to expire (once, capped by `QUEUE_MAX_WAIT_MS`, default 30s) instead of failing fast with 503. Set it to `0` to restore immediate 503s.

### Down alerts

Set **Alert webhook URL** (or `ALERT_WEBHOOK_URL`) to get a JSON POST on dead keys and pool exhaustion — 15-minute dedupe per event so it can't spam. For Telegram, use your bot URL with the chat id as a query param:
`https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>`

### Per-model stats

The Overview dashboard shows a **Models** table: requests, errors and average latency per model over the last 24h, with the top provider per model. Same data as JSON at `GET /api/metrics/models?hours=24`.

## 🐳 Docker

```bash
cp accounts.example.json accounts.json   # then fill in your keys
cp proxies.example.json proxies.json     # optional
docker compose up -d --build
```

Dashboard at http://localhost:8080/dashboard. Configs mount read-write so the dashboard can manage them; the SQLite database lives in the `om-data` volume.

## 🚀 Quick start

```bash
git clone https://github.com/mcptears/opencode-max.git
cd opencode-max
./scripts/install.sh
```

Then from anywhere:

| Command | Does what |
|---|---|
| `opencode-max --tray` | Tray mode (recommended) |
| `opencode-max --open` | Start + open the dashboard |
| `opencode-max --help` | All options |

Manual setup:

```bash
npm install
cp accounts.example.json accounts.json   # add your real keys (or use Connect flow)
cp proxies.example.json proxies.json     # optional
npm run build
npm start
```

Point OpenCode at it:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "provider": {
    "opencode-max": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8080/v1", "apiKey": "any" }
    }
  }
}
```

## 🖥️ Dashboard, tray & auto-start

**🌐 Web dashboard** (`http://127.0.0.1:8080/dashboard`) — live stats, account management (keys never displayed), proxy pool editing, manual rotation, all settings, event log. No terminal needed.

**🔔 System tray** — `opencode-max --tray` hides the terminal. Menu: Open Dashboard · Rotate IP now · Auto-start toggle · Quit. Native on macOS/Linux, PowerShell `NotifyIcon` on Windows, terminal fallback on headless systems.

**⚡ Auto-start** — toggle from the tray menu. Per OS: macOS LaunchAgent, Windows Startup-folder `.vbs`, Linux XDG autostart.

**🖧 Headless / servers:**

```bash
./scripts/install-service-linux.sh --enable-now   # systemd user service
pm2 start ecosystem.config.cjs && pm2 startup     # pm2, any OS
```

## 🔧 Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `UPSTREAM_BASE` | `https://opencode.ai/zen/v1` | Zen gateway base URL |
| `ACCOUNTS_FILE` | `./accounts.json` | Account pool file (**never commit**) |
| `PROXIES_FILE` | `./proxies.json` | Egress proxy pool (**never commit**) |
| `PROXY_LIST` | — | Comma-separated proxies; overrides the file |
| `ADMIN_TOKEN` | — | Bearer token guarding mutating admin endpoints |
| `MAX_RETRIES` | `5` | Transparent retries per request |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | `1000` / `30000` | Backoff base / cap (±20% jitter) |
| `DEFAULT_COOLDOWN_MS` | `300000` | Token park time after a 429 |
| `REQUEST_TIMEOUT_MS` | `120000` | Per-attempt upstream timeout |
| `PROXY_HEALTH_CHECK` | `1` | Probe proxies and skip dead ones |
| `PROXY_HEALTH_INTERVAL_MS` | `60000` | Health probe interval |
| `EGRESS_FAMILY` | `auto` | Direct-egress IP family: `auto`/`4`/`6` |
| `QUOTA_5H_LIMIT` | `200` | Per-account rolling 5h request budget |
| `TOKEN_SAVER` | `1` | Compress oversized tool results |
| `TOKEN_SAVER_MAX_CHARS` | `20000` | Max chars per tool result |
| `AUTO_SCRAPE` | `0` | Re-scrape free proxies on a schedule |
| `AUTO_SCRAPE_INTERVAL_HOURS` | `6` | Hours between scheduled scrapes |
| `ROUTING_STRATEGY` | `priority` | `priority` (P1 first) or `latency` (fastest first) |
| `QUEUE_MAX_WAIT_MS` | `30000` | Max wait for a cooling account before 503 (`0` = fail fast) |
| `ALERT_WEBHOOK_URL` | _(empty)_ | JSON webhook for dead-key / pool-exhaustion alerts |

`accounts.json` — array of `{ id, name, provider, apiKey, priority, cooldownPeriod?, baseUrl? }`.
`proxies.json` — array (or `{ "proxies": [...] }`) of `http://user:pass@host:port` URLs.

## 🔌 Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/chat/completions` | `POST` | OpenAI-compatible completions (SSE supported) |
| `/v1/messages` | `POST` | Anthropic-style messages, passed through |
| `/v1/models` | `GET` | Model list passthrough |
| `/v1/*` | `*` | Catch-all passthrough for other Zen paths |
| `/v1/accounts` | `GET` | Pool status (keys never exposed) |
| `/v1/rotate` | `POST` | Manual egress IP rotation |
| `/health` | `GET` | Liveness + pool summary |

**Admin API** (`/api/*`, token-guarded when `ADMIN_TOKEN` is set): `/api/status`, `/api/metrics`, `/api/metrics/history`, `/api/accounts`, `/api/accounts/validate`, `/api/accounts/:id/reset`, `/api/proxies`, `/api/rotate`, `/api/settings`.

## 🧪 Testing

```bash
npm test   # vitest — 34 tests, isolated temp SQLite via OM_DATA_DIR
```

## ⚠️ Disclaimer

Built for educational and infrastructure-resilience purposes. You are responsible for complying with OpenCode's terms of service and acceptable use policies.

## 📄 License

MIT
