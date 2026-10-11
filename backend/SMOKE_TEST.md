# Smoke Test — Go server (`hadi` branch)

Date: 2026-10-11. Binary built from `backend/` with Go 1.23.
Run with isolated files: `ACCOUNTS_FILE`, `PROXIES_FILE`, `SETTINGS_FILE`,
`PROVIDERS_FILE`, `OM_DATA_DIR`, `PORT=18080`.

## Results

| # | Endpoint | Result |
|---|----------|--------|
| 1 | `GET /health` | ✅ 200 — `{"ok":true,"accounts":0,"providers":[{opencode-zen}],"ip":{...}}` |
| 2 | `GET /api/providers` | ✅ 200 — lists `opencode-zen` |
| 3 | `POST /api/providers/preset/qwen` | ✅ 201 — qwen provider created with `qwen-web` protocol + modelMap |
| 4 | `GET /api/providers` (after) | ✅ 200 — qwen present |
| 5 | `GET /api/metrics` | ✅ 200 — events + counters JSON |
| 6 | `GET /api/playground/models` | ❌ 404 `page not found` — endpoint not implemented yet |
| 7 | `POST /api/accounts` (dummy qwen account) | ✅ 201 — `{"ok":true}` |
| 8 | `GET /api/accounts` | ✅ 200 — account listed, `state:"active"`, `useProxy:true` default |
| 9 | `GET /v1/models` | ✅ 200 — OpenAI list format with qwen models |
| 10 | `POST /v1/chat/completions` (dummy creds) | ✅ 502 graceful — `{"error":{"message":"qwen create-chat returned no chat id","status":502}}` (no crash) |
| 11 | `GET /metrics` (prometheus) | ⚠️ 200 but empty body — stub, not wired |

## Bugs found and fixed

1. **Stale provider list in Upstream closure** (fixed): `main.go` captured the
   provider slice once at startup, so providers added via the API (e.g. the
   qwen preset) were invisible to `/v1/*` routing — requests for
   `qwen3.7-plus` fell through to `opencode-zen` ("no accounts available for
   provider opencode-zen"). Fix: added `wire.ProviderStore.LoadTypes()` and
   the `Upstream.Providers` closure now re-loads from disk on every request.
2. **`db open: mkdir : no such file or directory` warning** (fixed): `main.go`
   passed `""` to `db.Open`. Fix: use `db.DataDir()` (`OM_DATA_DIR` or `./data`).

## Notes

- `go build ./...` passes; `go test ./...` all green.
- `go vet` reports pre-existing issues in `api/admin.go` (accessing fields on
  `any` values, e.g. `rq.LatencyMs`) — not touched, build unaffected.
- `/api/playground/models` and `/api/playground/chat` are not yet registered
  in the Go router; the React Playground page calls them.
- `/metrics` returns 200 with an empty body (prometheus adapter is a stub).
- Server shuts down cleanly on SIGTERM; no stray processes left.
