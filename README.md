# DevKit MCP

A dependency-free **Model Context Protocol (MCP)** server running on Cloudflare Workers. Point any MCP-capable client (Claude Code, OpenClaw, Cursor, etc.) at it and get dev utilities on tap — base64, hashing, UUID, passwords, epoch/time, JSON formatting, cron explanation.

**No npm dependencies, no build step, no server to run.** Just a single Workers script.

## Why

MCP is the fastest-growing protocol in the AI tooling ecosystem. Every server template out there assumes you're building a Stripe or Notion integration. This is a minimal, copy-paste-able example of the **stateless HTTP transport** running entirely on Cloudflare's free tier — the same stack as devhandbook.io itself.

## Tools

| Tool | Description |
|------|-------------|
| `base64_encode` | Encode a UTF-8 string to base64 |
| `base64_decode` | Decode base64 → UTF-8 |
| `hash` | SHA-1 / SHA-256 / SHA-512 hex digest |
| `uuid` | Random UUID v4 (1–20 at a time) |
| `password` | Cryptographically secure random password |
| `epoch` | Convert between Unix timestamps and dates |
| `json_format` | Pretty-print or minify JSON |
| `cron_explain` | Explain a cron expression in plain English |

## Deploy

```bash
export CLOUDFLARE_API_TOKEN="your-token"
npm install
npm run deploy
```

You'll get a `*.workers.dev` URL. That URL **is** your MCP endpoint.

## Connect a client

MCP over HTTP uses a single `POST` endpoint (no SSE, no stdio). Configure your client with the URL you got from deploy.

- **Claude Code:** `claude mcp add devkit --transport http <your-url>`
- **Cursor / others:** add a remote MCP server with the URL.

## Test it directly

```bash
# Handshake
curl -X POST <your-url> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# List tools
curl -X POST <your-url> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call a tool
curl -X POST <your-url> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"password","arguments":{"length":24}}}'
```

## How it works

- `GET /` — human-readable landing page listing the tools.
- `POST /` — JSON-RPC 2.0. Supports `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`.
- Stateless: no sessions, no `Mcp-Session-Id` header needed. Each request is independent.
- Zero dependencies: `btoa`/`atob` and `crypto.subtle` are built into the Workers runtime.

## Extending

Add a tool by dropping an entry into the `TOOLS` object in `src/index.js`:

```js
your_tool: {
  description: "What it does.",
  inputSchema: {
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x"],
  },
  handler: ({ x }) => textResult(`you said ${x}`),
},
```

That's it — `tools/list` and `tools/call` pick it up automatically.
