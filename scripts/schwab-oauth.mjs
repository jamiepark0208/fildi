#!/usr/bin/env node
/**
 * Schwab OAuth (individual Trader API) — auto-captures callback on :8182
 *
 *   node --env-file=.env.local scripts/schwab-oauth.mjs
 *   node --env-file=.env.local scripts/schwab-oauth.mjs 'https://127.0.0.1:8182/?code=...'
 *
 * Env: SCHWAB_CLIENT_ID (or SCHWAB_APP_KEY), SCHWAB_SECRET (or SCHWAB_APP_SECRET)
 * Callback default: https://127.0.0.1:8182  (must match developer portal exactly)
 */
import { createServer } from "node:https";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const clientId = process.env.SCHWAB_CLIENT_ID || process.env.SCHWAB_APP_KEY;
const secret = process.env.SCHWAB_SECRET || process.env.SCHWAB_APP_SECRET;
const callback = process.env.SCHWAB_CALLBACK_URL || "https://127.0.0.1:8182";

if (!clientId || !secret) {
  console.error("Missing SCHWAB_CLIENT_ID / SCHWAB_SECRET in env");
  process.exit(1);
}

const pastedArg = process.argv[2]?.trim();
// schwab-auth-watch.mjs raises this so an unattended prompt waits for Jamie.
const timeoutMs = Number(process.env.SCHWAB_OAUTH_TIMEOUT_MS) || 180_000;

function normalizeAuthCode(raw) {
  let code = String(raw ?? "").trim();
  // Schwab codes are percent-encoded in the redirect URL and almost always end in @ (%40).
  // Decode until stable; never leave a trailing %40 encoded.
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(code);
      if (next === code) break;
      code = next;
    } catch {
      break;
    }
  }
  // If paste was truncated before @ but still has the hex body, don't invent bytes —
  // only accept when we clearly have a full code.
  return code;
}

async function exchangeCode(codeRaw) {
  const code = normalizeAuthCode(codeRaw);
  console.log("Exchanging code:", {
    len: code.length,
    endsWithAt: code.endsWith("@"),
    redirect_uri: callback,
    clientIdLen: clientId.length,
    secretLen: secret.length,
  });
  if (!code.endsWith("@")) {
    console.warn(
      "Warning: Schwab codes usually end with '@'. If paste truncated before %40, exchange will fail — get a fresh URL.",
    );
  }

  const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
  // Build body manually so redirect_uri / code encoding is explicit and single-pass.
  const body =
    "grant_type=authorization_code" +
    "&code=" + encodeURIComponent(code) +
    "&redirect_uri=" + encodeURIComponent(callback);

  const tokenRes = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    console.error("Token exchange failed", tokenRes.status, tokenJson);
    console.error(
      "Retry checklist: (1) NEW browser login — codes are single-use + expire in ~30s\n" +
        "(2) paste FULL address bar URL in single quotes\n" +
        "(3) redirect_uri must match authorize + portal exactly:",
      callback,
    );
    process.exit(1);
  }
  return tokenJson;
}

async function probeAndSave(tokenJson) {
  const { access_token, refresh_token, expires_in, token_type } = tokenJson;
  console.log("Token OK:", {
    token_type,
    expires_in,
    access_len: access_token?.length,
    refresh_len: refresh_token?.length,
  });

  const dir = join(homedir(), ".tradedash");
  mkdirSync(dir, { recursive: true });
  const tokenPath = join(dir, "schwab-tokens.json");
  writeFileSync(
    tokenPath,
    JSON.stringify(
      {
        obtainedAt: new Date().toISOString(),
        expiresIn: expires_in,
        access_token,
        refresh_token,
        callback,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log("Wrote", tokenPath);

  const q = await fetch("https://api.schwabapi.com/marketdata/v1/quotes?symbols=AAPL,SPY", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const qText = await q.text();
  console.log("Quotes HTTP", q.status);
  console.log(qText.slice(0, 900));
  if (!q.ok) process.exit(1);
  console.log("\nSchwab market data connected.");
}

function codeFromUrl(pasted) {
  try {
    return new URL(pasted).searchParams.get("code");
  } catch {
    const m = pasted.match(/[?&]code=([^&]+)/);
    return m?.[1] ?? null;
  }
}

function ensureLocalCert() {
  const dir = join(homedir(), ".tradedash");
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "oauth-localhost.key");
  const certPath = join(dir, "oauth-localhost.crt");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    console.log("Generating one-time self-signed cert for https://127.0.0.1:8182 …");
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 825 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
      { stdio: "ignore" },
    );
  }
  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}

if (pastedArg) {
  const code = codeFromUrl(pastedArg);
  if (!code) {
    console.error("No code= in argument URL");
    process.exit(1);
  }
  const tokens = await exchangeCode(code);
  await probeAndSave(tokens);
  process.exit(0);
}

const authUrl =
  "https://api.schwabapi.com/v1/oauth/authorize?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: "code",
    // cache-buster so Chrome doesn't reuse a stale approve page
    state: randomBytes(8).toString("hex"),
  }).toString();

const u = new URL(callback);
const port = Number(u.port || 443);
if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
  console.error("Auto-capture only supports localhost callbacks. Pass the redirect URL as argv.");
  process.exit(1);
}

const { key, cert } = ensureLocalCert();

const done = new Promise((resolve, reject) => {
  const server = createServer({ key, cert }, async (req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", callback);
      const code = reqUrl.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Missing code</h1><p>Close and retry OAuth.</p>");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>TradeDash Schwab linked</h1><p>You can close this tab and return to the terminal.</p>");
      server.close();
      resolve(code);
    } catch (err) {
      reject(err);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Listening for Schwab callback on ${callback}`);
    console.log("Opening Google Chrome…");
    console.log("(If Chrome warns about the certificate, click Advanced → Proceed to 127.0.0.1)");
    try {
      execSync(`open -a "Google Chrome" "${authUrl}"`);
    } catch {
      console.log("Open manually:\n", authUrl);
    }
  });
  server.on("error", reject);
  setTimeout(() => {
    server.close();
    reject(new Error(`Timed out waiting for OAuth callback (${Math.round(timeoutMs / 60_000)} min)`));
  }, timeoutMs);
});

const code = await done;
console.log("Got authorization code — exchanging…");
const tokens = await exchangeCode(code);
await probeAndSave(tokens);
process.exit(0); // keep-alive socket + 3-min timer would otherwise hold the terminal open
