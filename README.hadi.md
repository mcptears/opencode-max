# Hadi — opencode-max, rewritten in Go + React

`hadi` is a complete rewrite of opencode-max: the backend is a single Go binary
(no Node.js runtime) and the dashboard is a React + Vite + TypeScript app.
Same product, same API surface — faster startup, one static binary to deploy.

```
                       ┌─────────────────────────────────────────┐
                       │            Hadi (Go binary)             │
clients ──/v1/*───────▶│  account pool → proxy rotator ─┐        │
  (OpenAI clients,     │                                │        │
   agents, SDKs)       │  ┌─────────────┐  ┌──────────┐ │        │
                       │  │ openai      │  │ qwen-web │ │        │
dashboard ──/api/*────▶│  │ (passthru)  │  │ (native) │─┼──▶ upstream
  (React SPA)          │  ├─────────────┤  ├──────────┤ │        │
                       │  │deepseek-web │  │ zai-web  │ │        │
                       │  │ (native)    │  │ (native) │ │        │
                       │  └─────────────┘  └──────────┘ │        │
                       └─────────────────────────────────────────┘
```

- **Account pool**: priority-ordered multi-account rotation, per-account
  cooldown after 429/quota, dead-key detection, optional per-account proxy
  bypass.
- **Proxy rotator**: round-robin over healthy proxies with health checks,
  IPv4/IPv6 egress families, quality tracking.
- **Native web protocols**: Qwen, DeepSeek and Z.ai are spoken directly
  (chat lifecycle, SSE translation to OpenAI chunks) — no sidecar services.

## Quick start

```bash
# Backend — builds a single static binary
cd backend
go build -o hadi-server .
./hadi-server            # API on :8080

# Frontend — React dashboard (separate process for now)
cd frontend
npm install
npm run dev              # dev server with hot reload
# or: npm run build      # static files land in frontend/dist/
```

The Go server exposes the JSON API on `http://localhost:8080`
(`/v1/*`, `/api/*`, `/health`, `/metrics`). Serve `frontend/dist` with any
static server (or use `npm run dev`) for the dashboard UI.

## Configuration

All backend configuration is via environment variables:

| Variable             | Default                        | Description                              |
|----------------------|--------------------------------|------------------------------------------|
| `PORT`               | `8080`                         | HTTP listen port                         |
| `UPSTREAM_BASE`      | `https://opencode.ai/zen/v1`   | Default OpenAI-compatible upstream       |
| `ACCOUNTS_FILE`      | `./accounts.json`              | Account pool file                        |
| `PROXIES_FILE`       | `./proxies.json`               | Proxy pool file (missing = direct egress)|
| `PROXY_LIST`         | —                              | Comma-separated proxies (overrides file) |
| `SETTINGS_FILE`      | `./settings.json`              | Dashboard-editable settings file         |
| `PROVIDERS_FILE`     | `./providers.json`             | Provider registry file                   |
| `MAX_RETRIES`        | `5`                            | Upstream retry budget                    |
| `RETRY_BASE_MS`      | `1000`                         | Retry backoff base                       |
| `RETRY_MAX_MS`       | `30000`                        | Retry backoff cap                        |
| `DEFAULT_COOLDOWN_MS`| `300000`                       | Account park time after 429/quota        |
| `REQUEST_TIMEOUT_MS` | `120000`                       | Per-request upstream timeout             |

Client API tokens (`clientTokens`, guarding `/v1/*`) and the admin token
(`adminToken`, guarding mutating `/api/*` calls) are **dashboard settings**,
not env vars — set them in Settings or leave empty for open local access.

## API overview

**OpenAI-compatible** (`/v1/*`, CORS enabled, optional client-token auth):

| Method | Path                  | Description                              |
|--------|-----------------------|------------------------------------------|
| POST   | `/v1/chat/completions`| Chat completions (SSE streaming supported)|
| POST   | `/v1/messages`        | Anthropic-style messages passthrough      |
| GET    | `/v1/models`          | Aggregated model catalog (60s cache)      |
| GET    | `/v1/accounts`        | Pool account summary                      |
| POST   | `/v1/rotate`          | Force egress rotation                     |
| *      | `/v1/*`               | Catch-all upstream passthrough            |

**Admin** (`/api/*`, mutating methods require admin token when set):

| Area      | Endpoints |
|-----------|-----------|
| Status    | `GET /api/status`, `GET /api/metrics`, `GET /api/metrics/history`, `GET /api/metrics/models`, `GET /api/metrics/providers`, `GET /api/usage`, `GET /api/requests` |
| Logs      | `GET /api/logs`, `DELETE /api/logs` |
| Accounts  | `GET/POST /api/accounts`, `PUT/PATCH/DELETE /api/accounts/{id}`, `POST /api/accounts/{id}/reset`, `POST /api/accounts/validate`, `POST /api/accounts/validate-qwen`, `POST /api/accounts/qwen-login`, `POST /api/accounts/validate-deepseek`, `POST /api/accounts/deepseek-login`, `POST /api/accounts/deepseek-resend-code`, `POST /api/accounts/validate-zai` |
| Providers | `GET/POST /api/providers`, `PUT/DELETE /api/providers/{id}`, `POST /api/providers/preset/{qwen,deepseek,opencode-zen,zai}`, `POST /api/providers/{id}/test` |
| Proxies   | `GET/POST/DELETE /api/proxies`, `POST /api/rotate`, `POST /api/proxies/test`, `POST /api/proxies/check` |
| Scraper   | `GET /api/scraper/providers`, `GET /api/scraper/status`, `POST /api/scraper/run`, `POST/PUT/DELETE /api/scraper/providers/{id}` |
| Settings  | `GET/POST /api/settings` |
| Misc      | `POST /api/backup/restore`, `POST /api/playground/chat` |

Operational: `GET /health`, `GET /metrics` (Prometheus format) — no auth.

## Providers

Four upstream protocols, selected per provider:

| Protocol       | Upstream              | Auth |
|----------------|-----------------------|------|
| `openai`       | Any OpenAI-compatible base URL (default: OpenCode Zen) | Bearer API key |
| `qwen-web`     | chat.qwen.ai (native) | Paste token + session cookies from your browser |
| `deepseek-web` | chat.deepseek.com (native) | Email+password sign-in (verification-code flow supported) or paste token + cookies |
| `zai-web`      | chat.z.ai (native)    | Paste JWT from Local Storage |

Accounts connect from the dashboard — no JSON editing, no separate
deployments. Use **+ Add provider → Built-in** to restore a deleted default
provider without touching its accounts.

## Docker

Docker packaging for the Go + React build is in progress
(no `Dockerfile.hadi` / `docker-compose.hadi.yml` yet).
