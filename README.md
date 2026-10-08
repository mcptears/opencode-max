# opencode-max

A unified proxy wrapper for **OpenCode Zen** that combines **IP rotation** with
**multi-account API key management** in a single Node.js/TypeScript + Express server.

Inspired by the architecture of two community projects:

- [rahadiana/opencode-multi-account](https://github.com/rahadiana/opencode-multi-account) —
  priority-ordered token pools with cooldown reactivation.
- [alztrk/opencode-ip-rotator](https://github.com/alztrk/opencode-ip-rotator) —
  round-robin outbound proxy pools and manual `/api/rotate`.

## How it works

```
[OpenCode client] ──HTTP──> [opencode-max :8080] ──HTTPS (+proxy)──> https://opencode.ai/zen/v1
                              │
                              ├─ accounts.json  → priority token pool (P1 → P2 → …)
                              ├─ proxies.json   → round-robin egress proxy pool
                              └─ ses_*          → session id, rotated on every 429
```

Every outgoing request:

1. Takes the highest-priority **active** token from the pool and attaches it as
   `Authorization: Bearer <token>`.
2. Strips identity/telemetry artifacts: hop-by-hop headers, cookies, spoofed
   `x-real-ip`/`x-forwarded-for` hints (OpenCode's edge overwrites them anyway),
   telemetry blobs in JSON payloads, and persistent `session_id` GUIDs.
3. Routes through the currently selected egress proxy (or direct if no proxies
   are configured).

On **429 / quota / transient 5xx** from upstream:

1. The token is parked for its `cooldownPeriod` (auto-reactivates afterwards).
2. The egress IP is rotated to the next proxy in the pool.
3. A fresh `ses_*` session id is minted and stale session GUIDs are stripped.
4. The request is retried transparently with exponential backoff + jitter
   (configurable via `MAX_RETRIES`, `RETRY_BASE_MS`, `RETRY_MAX_MS`).

This mirrors OpenCode Zen's real behavior: the rate-limit bucket is keyed on the
raw egress IP (~15–20 RPM, no `retry-after` header), so a genuine egress change
— not header spoofing — is what resets the bucket.

## Quick start

One command — installs, builds, and puts `opencode-max` on your PATH (like 9router):

```bash
git clone https://github.com/mcptears/opencode-max.git
cd opencode-max
./scripts/install.sh
```

Then just type it anywhere — no separate commands:

```bash
opencode-max --tray    # tray mode (recommended)
opencode-max --open    # start + open the dashboard
opencode-max --help    # all options
```

Manual setup, if you prefer:

```bash
npm install
cp accounts.example.json accounts.json   # add your real keys
cp proxies.example.json proxies.json     # add your proxies (optional)
npm run build
npm start                                # or: npm link  →  opencode-max
```

The server listens on **port 8080** by default. Point OpenCode at it:

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

## 🖥️ Dashboard, tray & auto-start (9router-style)

**Web dashboard** — everything is configurable in the browser, no terminal needed:

```bash
npm start -- --open        # start + open the dashboard
# or just visit http://127.0.0.1:8080/dashboard
```

The dashboard shows live status (requests, 429s, rotations, uptime), lets you
**add/remove accounts** (keys are never displayed), **edit the proxy pool**,
trigger **manual IP rotation**, tweak **all settings** (retry policy, cooldowns,
upstream, admin token), and watch a live event log.

**System tray** — hide the terminal, control from the tray icon:

```bash
npm run tray   # node dist/index.js --tray
```

Tray menu: Open Dashboard · Rotate IP now · Enable/disable auto-start · Quit.
Uses the `systray` package on macOS/Linux and a PowerShell `NotifyIcon`
(zero binaries) on Windows. On headless systems it falls back to terminal mode.

**Auto-start on login** — toggle it from the tray menu or run once:

```bash
node dist/index.js --tray   # then enable via tray menu
```

Mechanism per OS (same approach as 9router): macOS LaunchAgent
(`~/Library/LaunchAgents/com.opencode-max.autostart.plist`), Windows Startup
folder `.vbs` (hidden window), Linux XDG autostart
(`~/.config/autostart/opencode-max.desktop`).

**Headless / server auto-run:**

```bash
./scripts/install-service-linux.sh --enable-now   # systemd user service (Linux)
# or
pm2 start ecosystem.config.cjs && pm2 startup     # pm2 (any OS)
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `UPSTREAM_BASE` | `https://opencode.ai/zen/v1` | Zen gateway base URL |
| `ACCOUNTS_FILE` | `./accounts.json` | Account pool file (**never commit**) |
| `PROXIES_FILE` | `./proxies.json` | Egress proxy pool (**never commit**) |
| `PROXY_LIST` | — | Comma-separated proxies; overrides the file |
| `MAX_RETRIES` | `5` | Transparent retries per request |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | `1000` / `30000` | Backoff base / cap (±20% jitter) |
| `DEFAULT_COOLDOWN_MS` | `300000` | Token park time after a 429 |
| `REQUEST_TIMEOUT_MS` | `120000` | Per-attempt upstream timeout |

`accounts.json` — array of `{ id, name, provider, apiKey, priority, cooldownPeriod?, baseUrl? }`.
`proxies.json` — array (or `{ "proxies": [...] }`) of `http://user:pass@host:port` URLs.

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/chat/completions` | `POST` | OpenAI-compatible completions (SSE supported) |
| `/v1/messages` | `POST` | Anthropic-style messages, passed through |
| `/v1/models` | `GET` | Model list passthrough |
| `/v1/*` | `*` | Catch-all passthrough for other Zen paths |
| `/v1/accounts` | `GET` | Pool status (keys never exposed) |
| `/v1/rotate` | `POST` | Manual egress IP rotation |
| `/health` | `GET` | Liveness + pool summary |

## Disclaimer

Built for educational and infrastructure-resilience purposes. You are responsible
for complying with OpenCode's terms of service and acceptable use policies.

## License

MIT
