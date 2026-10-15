/**
 * In-app Schwab OAuth capture (A73): listen on the registered localhost callback,
 * exchange the code, write ~/.tradedash/schwab-tokens.json.
 */
import { createServer, type Server } from "node:https";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  getSchwabOAuthClient,
  saveSchwabOAuthTokens,
  getSchwabAccessToken,
  getSchwabAuthStatus,
} from "./schwab-auth.js";
import { logger } from "./logger.js";

type CaptureState = {
  server: Server | null;
  state: string | null;
  authorizeUrl: string | null;
  status: "idle" | "listening" | "exchanging" | "done" | "error";
  error: string | null;
  startedAt: number | null;
};

const capture: CaptureState = {
  server: null,
  state: null,
  authorizeUrl: null,
  status: "idle",
  error: null,
  startedAt: null,
};

const CAPTURE_TIMEOUT_MS = 180_000;

function ensureLocalCert(): { key: Buffer; cert: Buffer } {
  const dir = join(homedir(), ".tradedash");
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "oauth-localhost.key");
  const certPath = join(dir, "oauth-localhost.crt");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 825 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
      { stdio: "ignore" },
    );
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

function normalizeAuthCode(raw: string): string {
  let code = String(raw ?? "").trim();
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(code);
      if (next === code) break;
      code = next;
    } catch {
      break;
    }
  }
  return code;
}

async function exchangeCode(codeRaw: string, callback: string, clientId: string, clientSecret: string) {
  const code = normalizeAuthCode(codeRaw);
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
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
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokenJson.access_token || !tokenJson.refresh_token) {
    throw new Error(tokenJson.error_description || tokenJson.error || `HTTP ${tokenRes.status}`);
  }
  return tokenJson;
}

function stopServer(): void {
  try {
    capture.server?.close();
  } catch {
    /* ignore */
  }
  capture.server = null;
}

export function getSchwabOAuthCaptureStatus(): {
  status: CaptureState["status"];
  error: string | null;
  authorizeUrl: string | null;
  auth: ReturnType<typeof getSchwabAuthStatus>;
} {
  return {
    status: capture.status,
    error: capture.error,
    authorizeUrl: capture.authorizeUrl,
    auth: getSchwabAuthStatus(),
  };
}

/** Start (or reuse) localhost callback listener; return authorize URL for the browser. */
export async function startSchwabOAuthCapture(): Promise<{ authorizeUrl: string; callback: string }> {
  const client = getSchwabOAuthClient();
  if (!client) throw new Error("SCHWAB_CLIENT_ID / SCHWAB_SECRET missing");

  const u = new URL(client.callback);
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
    throw new Error("In-app capture only supports localhost callbacks");
  }
  const port = Number(u.port || 443);

  if (capture.status === "listening" && capture.authorizeUrl) {
    return { authorizeUrl: capture.authorizeUrl, callback: client.callback };
  }

  stopServer();
  const state = randomBytes(8).toString("hex");
  const authorizeUrl =
    "https://api.schwabapi.com/v1/oauth/authorize?" +
    new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: client.callback,
      response_type: "code",
      state,
    }).toString();

  capture.state = state;
  capture.authorizeUrl = authorizeUrl;
  capture.status = "listening";
  capture.error = null;
  capture.startedAt = Date.now();

  const { key, cert } = ensureLocalCert();

  await new Promise<void>((resolve, reject) => {
    const server = createServer({ key, cert }, async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", client.callback);
        const code = reqUrl.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Missing code</h1><p>Close and retry Schwab link from TradeDash Settings.</p>");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>TradeDash Schwab linked</h1><p>You can close this tab and return to the app.</p>");
        stopServer();
        capture.status = "exchanging";
        try {
          const tokens = await exchangeCode(code, client.callback, client.clientId, client.clientSecret);
          saveSchwabOAuthTokens({
            access_token: tokens.access_token!,
            refresh_token: tokens.refresh_token!,
            expires_in: tokens.expires_in,
            callback: client.callback,
          });
          await getSchwabAccessToken();
          capture.status = "done";
          capture.error = null;
          logger.info("schwab-oauth: in-app capture complete");
        } catch (err) {
          capture.status = "error";
          capture.error = String((err as Error)?.message ?? err);
          logger.warn({ err: capture.error }, "schwab-oauth: exchange failed");
        }
      } catch (err) {
        capture.status = "error";
        capture.error = String((err as Error)?.message ?? err);
      }
    });
    capture.server = server;
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", (err) => {
      capture.status = "error";
      capture.error = String(err);
      reject(err);
    });
    setTimeout(() => {
      if (capture.status === "listening") {
        stopServer();
        capture.status = "error";
        capture.error = "Timed out waiting for OAuth callback (3 min)";
      }
    }, CAPTURE_TIMEOUT_MS);
  });

  return { authorizeUrl, callback: client.callback };
}

/** Paste-fallback: exchange a full redirect URL or bare code without the listener. */
export async function completeSchwabOAuthFromRedirect(pasted: string): Promise<void> {
  const client = getSchwabOAuthClient();
  if (!client) throw new Error("SCHWAB_CLIENT_ID / SCHWAB_SECRET missing");
  let code: string | null = null;
  try {
    code = new URL(pasted).searchParams.get("code");
  } catch {
    const m = pasted.match(/[?&]code=([^&]+)/);
    code = m?.[1] ?? (pasted.includes("@") || pasted.length > 20 ? pasted : null);
  }
  if (!code) throw new Error("No code= in pasted URL");
  capture.status = "exchanging";
  const tokens = await exchangeCode(code, client.callback, client.clientId, client.clientSecret);
  saveSchwabOAuthTokens({
    access_token: tokens.access_token!,
    refresh_token: tokens.refresh_token!,
    expires_in: tokens.expires_in,
    callback: client.callback,
  });
  await getSchwabAccessToken();
  capture.status = "done";
  capture.error = null;
  stopServer();
}
