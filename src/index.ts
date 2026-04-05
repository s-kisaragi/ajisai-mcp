#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { SqliteMemoryStore } from "./store/sqlite-store.js";
import { LocalArchiveStore, S3ArchiveStore } from "./archive/index.js";
import type { ArchiveStore } from "./archive/index.js";
import { validateToken, handleDiscovery, handleRegister, handleAuthorizeGet, handleAuthorizePost, handleToken } from "./oauth.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerConversationTools } from "./tools/conversations.js";
import { registerImportClaudeAiTools } from "./tools/import-claude-ai.js";
import { registerProjectTools } from "./tools/projects.js";

// --- Config ---
const DATA_DIR = process.env.AJISAI_DATA_DIR ?? path.join(os.homedir(), ".ajisai");
const DB_PATH = path.join(DATA_DIR, "ajisai.db");
const MODE = process.env.AJISAI_TRANSPORT ?? (process.argv.includes("--http") ? "http" : "stdio");
const PORT = parseInt(process.env.AJISAI_PORT ?? "3000", 10);

fs.mkdirSync(DATA_DIR, { recursive: true });

// --- Store & Archive ---
const store = new SqliteMemoryStore(DB_PATH);

function createArchiveStore(): ArchiveStore {
  const bucket = process.env.AJISAI_S3_BUCKET;
  if (bucket) {
    return new S3ArchiveStore({
      bucket,
      prefix: process.env.AJISAI_S3_PREFIX ?? "ajisai",
      region: process.env.AJISAI_S3_REGION ?? "auto",
      endpoint: process.env.AJISAI_S3_ENDPOINT,
      accessKeyId: process.env.AJISAI_S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AJISAI_S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY,
    });
  }
  return new LocalArchiveStore(path.join(DATA_DIR, "archives"));
}

const archive = createArchiveStore();

// --- Tool Registration ---
function registerTools(s: McpServer) {
  registerMemoryTools(s, store);
  registerConversationTools(s, store, archive);
  registerImportClaudeAiTools(s, store, archive);
  registerProjectTools(s, store);
}

// --- MCP Server (stdio mode) ---
const server = new McpServer({ name: "ajisai-mcp", version: "0.1.0" });
registerTools(server);

// --- Transport: stdio ---
async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const archiveType = process.env.AJISAI_S3_BUCKET ? `s3://${process.env.AJISAI_S3_BUCKET}` : "local";
  console.error(`ajisai-mcp started [stdio] (db: ${DB_PATH}, archive: ${archiveType})`);
}

// --- Transport: HTTP (Streamable HTTP + OAuth) ---
async function startHttp() {
  const app = new Hono();

  const AUTH_PASSWORD = process.env.AJISAI_AUTH_PASSWORD;
  const BASE_URL = process.env.AJISAI_BASE_URL ?? `http://localhost:${PORT}`;
  const authEnabled = !!(AUTH_PASSWORD || process.env.AJISAI_AUTH_TOKEN);

  // OAuth endpoints
  if (AUTH_PASSWORD) {
    app.get("/.well-known/oauth-authorization-server", (c) => handleDiscovery(c, BASE_URL));
    app.post("/register", (c) => handleRegister(c));
    app.get("/authorize", (c) => handleAuthorizeGet(c, AUTH_PASSWORD));
    app.post("/authorize", (c) => handleAuthorizePost(c, AUTH_PASSWORD));
    app.post("/token", (c) => handleToken(c));
    console.error(`OAuth enabled (base: ${BASE_URL})`);
  } else if (process.env.AJISAI_AUTH_TOKEN) {
    console.error(`Auth enabled (static Bearer token)`);
  } else {
    console.error(`⚠ Auth disabled — set AJISAI_AUTH_PASSWORD or AJISAI_AUTH_TOKEN`);
  }

  // Session management
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  function checkAuth(req: Request): Response | null {
    if (!authEnabled) return null;
    const auth = req.headers.get("authorization") ?? undefined;
    if (auth && validateToken(auth)) return null;
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
      { status: 401 }
    );
  }

  app.post("/mcp", async (c) => {
    const rejected = checkAuth(c.req.raw);
    if (rejected) return rejected;

    const sessionId = c.req.header("mcp-session-id");
    const body = await c.req.json();
    const reqWithBody = new Request(c.req.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    });

    if (sessionId && transports.has(sessionId)) {
      return transports.get(sessionId)!.handleRequest(reqWithBody);
    }

    if (!sessionId && isInitializeRequest(body)) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { transports.set(sid, transport); },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      const sessionServer = new McpServer({ name: "ajisai-mcp", version: "0.1.0" });
      registerTools(sessionServer);
      await sessionServer.connect(transport);
      return transport.handleRequest(reqWithBody);
    }

    return c.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null },
      400
    );
  });

  app.get("/mcp", async (c) => {
    const rejected = checkAuth(c.req.raw);
    if (rejected) return rejected;
    const sessionId = c.req.header("mcp-session-id");
    if (!sessionId || !transports.has(sessionId)) return c.body(null, 400);
    return transports.get(sessionId)!.handleRequest(c.req.raw);
  });

  app.delete("/mcp", async (c) => {
    const rejected = checkAuth(c.req.raw);
    if (rejected) return rejected;
    const sessionId = c.req.header("mcp-session-id");
    if (!sessionId || !transports.has(sessionId)) return c.body(null, 400);
    return transports.get(sessionId)!.handleRequest(c.req.raw);
  });

  app.get("/health", (c) => c.json({ status: "ok", sessions: transports.size }));

  serve({ fetch: app.fetch, port: PORT }, () => {
    const archiveType = process.env.AJISAI_S3_BUCKET ? `s3://${process.env.AJISAI_S3_BUCKET}` : "local";
    console.error(`ajisai-mcp started [http://localhost:${PORT}/mcp] (db: ${DB_PATH}, archive: ${archiveType})`);
  });
}

// --- Main ---
async function main() {
  if (MODE === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
