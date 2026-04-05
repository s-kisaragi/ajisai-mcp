import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { Context } from "hono";

// --- Config ---
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// --- In-memory stores ---
interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  createdAt: number;
}

interface AccessToken {
  token: string;
  clientId: string;
  createdAt: number;
  expiresAt: number;
}

const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, AccessToken>();
const registeredClients = new Map<string, { clientId: string; clientSecret: string; redirectUris: string[] }>();

/** Clean up expired entries */
function cleanup() {
  const now = Date.now();
  for (const [k, v] of authCodes) {
    if (now - v.createdAt > CODE_EXPIRY_MS) authCodes.delete(k);
  }
  for (const [k, v] of accessTokens) {
    if (now > v.expiresAt) accessTokens.delete(k);
  }
}

setInterval(cleanup, 60_000);

/** Validate an access token, return true if valid */
export function validateToken(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);

  const staticToken = process.env.AJISAI_AUTH_TOKEN;
  if (staticToken && token === staticToken) return true;

  const entry = accessTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

/** OAuth 2.0 Authorization Server Metadata (RFC 8414) */
export function handleDiscovery(c: Context, baseUrl: string) {
  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

/** Dynamic Client Registration (RFC 7591) */
export async function handleRegister(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  const { redirect_uris, client_name } = body;

  const clientId = randomUUID();
  const clientSecret = randomBytes(32).toString("base64url");

  registeredClients.set(clientId, {
    clientId,
    clientSecret,
    redirectUris: Array.isArray(redirect_uris) ? redirect_uris : [],
  });

  return c.json({
    client_id: clientId,
    client_secret: clientSecret,
    client_name: client_name ?? "ajisai-client",
    redirect_uris: redirect_uris ?? [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, 201);
}

/** GET /authorize — show simple login page */
export function handleAuthorizeGet(c: Context, password: string) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = c.req.query();

  if (response_type !== "code") {
    return c.text("Invalid response_type", 400);
  }

  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ajisai-mcp — Authorize</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #1a1a2e; border: 1px solid #333; border-radius: 12px; padding: 2rem; max-width: 360px; width: 100%; }
    h1 { font-size: 1.2rem; margin: 0 0 0.5rem; color: #c4a7e7; }
    p { font-size: 0.85rem; color: #888; margin: 0 0 1.5rem; }
    input[type="password"] { width: 100%; padding: 0.7rem; background: #0a0a0a; border: 1px solid #444; border-radius: 6px; color: #e0e0e0; font-size: 1rem; box-sizing: border-box; }
    button { width: 100%; padding: 0.7rem; background: #c4a7e7; color: #0a0a0a; border: none; border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 1rem; }
    button:hover { background: #d4b7f7; }
  </style>
</head>
<body>
  <div class="card">
    <h1>ajisai-mcp</h1>
    <p>記憶にアクセスするには認証が必要よ。</p>
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${client_id ?? ""}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri ?? ""}">
      <input type="hidden" name="state" value="${state ?? ""}">
      <input type="hidden" name="code_challenge" value="${code_challenge ?? ""}">
      <input type="hidden" name="code_challenge_method" value="${code_challenge_method ?? "S256"}">
      <input type="hidden" name="response_type" value="code">
      <input type="password" name="password" placeholder="パスワード" required autofocus>
      <button type="submit">認証</button>
    </form>
  </div>
</body>
</html>`);
}

/** POST /authorize — validate password, issue code, redirect */
export async function handleAuthorizePost(c: Context, password: string) {
  const body = await c.req.parseBody();
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, password: inputPassword } = body as Record<string, string>;

  if (inputPassword !== password) {
    return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ajisai-mcp</title>
<style>body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e74c3c;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}
.card{background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:2rem;max-width:360px;text-align:center;}
a{color:#c4a7e7;}</style></head>
<body><div class="card"><p>パスワードが違うわ。</p><a href="javascript:history.back()">戻る</a></div></body></html>`, 403);
  }

  const code = randomBytes(32).toString("base64url");
  authCodes.set(code, {
    code,
    clientId: client_id ?? "",
    redirectUri: redirect_uri ?? "",
    codeChallenge: code_challenge ?? "",
    codeChallengeMethod: code_challenge_method ?? "S256",
    createdAt: Date.now(),
  });

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);

  return c.redirect(url.toString());
}

/** POST /token — exchange code for access token */
export async function handleToken(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  const { grant_type, code, code_verifier, client_id } = body;

  if (grant_type !== "authorization_code") {
    return c.json({ error: "unsupported_grant_type" }, 400);
  }

  const authCode = authCodes.get(code);
  if (!authCode) {
    return c.json({ error: "invalid_grant", error_description: "Invalid or expired code" }, 400);
  }

  if (authCode.codeChallenge && code_verifier) {
    const hash = createHash("sha256").update(code_verifier).digest("base64url");
    if (hash !== authCode.codeChallenge) {
      return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }
  }

  authCodes.delete(code);

  const token = randomBytes(48).toString("base64url");
  const now = Date.now();
  accessTokens.set(token, {
    token,
    clientId: client_id ?? authCode.clientId,
    createdAt: now,
    expiresAt: now + TOKEN_EXPIRY_MS,
  });

  return c.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: Math.floor(TOKEN_EXPIRY_MS / 1000),
  });
}
