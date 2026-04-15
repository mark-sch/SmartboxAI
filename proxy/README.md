# Smartbox LLM Proxy

A lightweight Node.js/Express proxy server for Kimi Code CLI.

## What it does

- Exposes a Kimi-Code-compatible API endpoint
- Authenticates incoming requests with a static Bearer token (`PROXY_AUTH_TOKEN`)
- Forwards requests 1:1 to a configurable target URL (e.g. the real Kimi Code API)
- Supports streaming (`text/event-stream`) transparently
- **Auto-refreshes** the target access token via OAuth when `PROXY_REFRESH_TOKEN` is configured
- **Session Logging**: Persists `wire.jsonl`, `context.jsonl`, and `state.json` per detected Kimi CLI session (based on `prompt_cache_key`)

## Setup

```bash
cd proxy
npm install
```

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `PROXY_TARGET_URL` | yes | URL to forward requests to (e.g. `https://api.kimi.com/coding/v1`) |
| `PROXY_AUTH_TOKEN` | yes | Bearer token that clients must present to the proxy |
| `PROXY_TARGET_TOKEN` | yes* | Token used when forwarding to the target. Ignored when `PROXY_REFRESH_TOKEN` is set (auto-refreshed). |
| `PROXY_REFRESH_TOKEN` | no | Refresh token. If set, the proxy auto-refreshes `PROXY_TARGET_TOKEN` and updates `.env`. |
| `PROXY_PORT` | no | Port to run the proxy on. Default: `3000` |
| `PROXY_LOG_LEVEL` | no | `verbose`, `info`, or `error`. Default: `info` |
| `OAUTH_HOST` | no | OAuth host for token refresh. Default: `https://auth.kimi.com` |

## Run

```bash
npm start
```

The proxy will listen on the configured port and log the target URL.

## Usage with Kimi CLI

1. Start the proxy
2. In Kimi CLI run `/login`
3. Select **"Smartbox LLM Proxy"**
4. Enter the proxy URL (e.g. `http://localhost:3000`) and the `PROXY_AUTH_TOKEN`
5. The CLI will fetch available models through the proxy and behave exactly like a direct Kimi Code connection

## Session Logging

Whenever the proxy receives a request containing a Kimi-specific `prompt_cache_key` in the JSON body, it creates a dedicated session folder under `sessions/<session_id>/` inside the proxy directory. The following files are maintained in a format analogous to Kimi CLI:

| File | Description |
|------|-------------|
| `wire.jsonl` | Metadata header + `ProxyRequest` / `ProxyResponse` records with timestamp |
| `context.jsonl` | Incrementally stored chat messages from the request body; `_usage` records are appended when token usage is available |
| `state.json` | Session state initialized with the same default structure as Kimi CLI |

Session IDs are also prefixed in all proxy `info` level console logs.

### Timing notes

The `total_time` field in `ProxyResponse` records measures the raw HTTP roundtrip from the internal `fetch()` call until the last response byte is consumed. Because Kimi CLI's "LLM step" timer wraps the entire kosong call (including request preparation), the proxy's `total_time` will typically be a few tens of milliseconds shorter or longer. This is expected and not a bug.

## Token Refresh

If you provide `PROXY_REFRESH_TOKEN` in `.env`, the proxy will:

1. Load the current access token
2. Check if it is close to expiry (threshold: `max(300s, 50% of lifetime)`)
3. Automatically call the OAuth refresh endpoint before forwarding the request
4. Save the new `access_token`, `refresh_token`, and expiry back into `.env`

This means you no longer need to manually copy a new access token every time it expires.
