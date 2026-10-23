/**
 * DevKit MCP — a dependency-free Model Context Protocol (MCP) server
 * running on Cloudflare Workers.
 *
 * Exposes dev utilities as MCP tools, served over the new HTTP transport
 * (single POST endpoint). No npm dependencies, no build step — pure ESM.
 *
 * Protocol: JSON-RPC 2.0 over HTTP POST to `/`.
 * Handshake: GET / returns the MCP info + a small landing page.
 */

// ---------------------------------------------------------------------------
// Tools — pure functions, no side effects. Each returns an MCP tool result.
// ---------------------------------------------------------------------------

const TOOLS = {
  base64_encode: {
    description: "Encode a UTF-8 string to base64.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to encode" } },
      required: ["text"],
    },
    handler: ({ text }) => textResult(btoa(unescape(encodeURIComponent(text)))),
  },

  base64_decode: {
    description: "Decode a base64 string to UTF-8 text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Base64 to decode" } },
      required: ["text"],
    },
    handler: ({ text }) => {
      try {
        return textResult(decodeURIComponent(escape(atob(text))));
      } catch {
        return textResult("(error) invalid base64 input");
      }
    },
  },

  hash: {
    description: "Compute SHA-1, SHA-256, or SHA-512 hex digest of a string.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to hash" },
        algo: { type: "string", enum: ["SHA-1", "SHA-256", "SHA-512"], default: "SHA-256" },
      },
      required: ["text"],
    },
    handler: async ({ text, algo = "SHA-256" }) => {
      const enc = new TextEncoder().encode(text);
      const buf = await crypto.subtle.digest(algo, enc);
      return textResult([...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    },
  },

  uuid: {
    description: "Generate one or more random UUID v4 strings.",
    inputSchema: {
      type: "object",
      properties: { count: { type: "integer", default: 1, minimum: 1, maximum: 20 } },
    },
    handler: ({ count = 1 }) => {
      const ids = [];
      for (let i = 0; i < count; i++) ids.push(crypto.randomUUID());
      return textResult(ids.join("\n"));
    },
  },

  password: {
    description: "Generate a cryptographically secure random password.",
    inputSchema: {
      type: "object",
      properties: {
        length: { type: "integer", default: 20, minimum: 8, maximum: 128 },
        includeSymbols: { type: "boolean", default: true },
      },
    },
    handler: ({ length = 20, includeSymbols = true }) => {
      const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      const symbols = "!@#$%^&*()-_=+[]{}<>?";
      const pool = letters + (includeSymbols ? symbols : "");
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      let out = "";
      for (const b of bytes) out += pool[b % pool.length];
      // guarantee at least one symbol + one digit when symbols requested
      if (includeSymbols) {
        const sym = symbols[bytes[0] % symbols.length];
        const dig = "0123456789"[bytes[1] % 10];
        out = out.slice(0, length - 2) + sym + dig;
      }
      return textResult(out);
    },
  },

  epoch: {
    description: "Convert between Unix timestamps (seconds/ms) and ISO/UTC dates.",
    inputSchema: {
      type: "object",
      properties: {
        value: {
          type: "string",
          description: "A Unix timestamp (seconds or ms) OR an ISO date string to convert.",
        },
      },
      required: ["value"],
    },
    handler: ({ value }) => {
      const v = String(value).trim();
      let d;
      if (/^-?\d+$/.test(v)) {
        const n = Number(v);
        d = new Date(Math.abs(n) < 1e12 ? n * 1000 : n);
      } else {
        d = new Date(v);
      }
      if (isNaN(d.getTime())) return textResult("(error) could not parse value");
      const lines = [
        "ISO UTC:  " + d.toISOString(),
        "ISO local:" + d.toString(),
        "Unix s:   " + Math.floor(d.getTime() / 1000),
        "Unix ms:  " + d.getTime(),
      ];
      return textResult(lines.join("\n"));
    },
  },

  json_format: {
    description: "Pretty-print or minify a JSON string.",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "string", description: "JSON text" },
        minify: { type: "boolean", default: false },
      },
      required: ["json"],
    },
    handler: ({ json, minify = false }) => {
      try {
        const parsed = JSON.parse(json);
        return textResult(JSON.stringify(parsed, null, minify ? 0 : 2));
      } catch (e) {
        return textResult("(error) invalid JSON: " + e.message);
      }
    },
  },

  cron_explain: {
    description: "Explain a cron expression in plain English.",
    inputSchema: {
      type: "object",
      properties: { expr: { type: "string", description: "5-field cron expression, e.g. '0 3 * * *'" } },
      required: ["expr"],
    },
    handler: ({ expr }) => {
      const parts = String(expr).trim().split(/\s+/);
      if (parts.length !== 5) return textResult("(error) need 5 fields: minute hour day-of-month month day-of-week");
      const [min, hour, dom, mon, dow] = parts;
      const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const when = (f) => (f === "*" ? "every" : f);
      const dowText = dow === "*" ? "day" : dow.split(",").map((x) => names[Number(x) % 7]).join(", ");
      const monText = mon === "*" ? "month" : mon.split(",").map((x) => months[Number(x) - 1]).join(", ");
      return textResult(
        `At minute ${when(min)}, hour ${when(hour)}, day-of-month ${when(dom)}, in ${monText}, on ${dowText}.`
      );
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text) {
  return {
    content: [{ type: "text", text }],
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

async function handleRpc(body) {
  const { jsonrpc, id, method, params } = body;

  // MCP initialize handshake
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "devkit-mcp", version: "1.0.0" },
      },
    };
  }

  if (method === "notifications/initialized") {
    return null; // no response for notifications
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }

  if (method === "tools/call") {
    const { name, arguments: args = {} } = params || {};
    const tool = TOOLS[name];
    if (!tool) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    try {
      const result = await tool.handler(args);
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      return { jsonrpc: "2.0", id, error: { code: -32603, message: e.message } };
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // MCP streamable HTTP: POST is the protocol; GET is the handshake/info.
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: { code: -32700, message: "Parse error" } }, 400);
      }

      const resp = await handleRpc(body);
      if (resp === null) return new Response(null, { status: 202 });

      // MCP requires `Mcp-Session-Id` header only for sessionful servers; we're stateless.
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET") {
      // Optionally support old-style SSE GET for compatibility.
      if (url.searchParams.get("stream") === "true") {
        return json({ error: "SSE transport not supported; use HTTP POST transport" }, 400);
      }
      return new Response(landing(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return json({ error: { code: -32600, message: "Method not allowed" } }, 405);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function landing() {
  const tools = Object.keys(TOOLS)
    .map((t) => `<li><code>${t}</code> — ${TOOLS[t].description}</li>`)
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>DevKit MCP</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:720px;margin:3rem auto;padding:0 1.5rem;color:#1d1d1f}code{background:#f5f5f7;padding:2px 6px;border-radius:5px}h1{font-size:2rem}a{color:#0071e3}ul{line-height:1.8}</style>
</head><body>
<h1>DevKit MCP</h1>
<p>A dependency-free <strong>Model Context Protocol</strong> server on Cloudflare Workers.
Point any MCP client at this URL and get dev utilities on tap.</p>
<p>Endpoint: <code>POST {url}</code></p>
<pre># In Claude Code / OpenClaw / Cursor — add a remote MCP server:
# (HTTP transport, no API key required)</pre>
<h2>Tools</h2>
<ul>
${tools}
</ul>
<p>Built by <a href="https://devhandbook.io">devhandbook.io</a>.</p>
</body></html>`;
}
