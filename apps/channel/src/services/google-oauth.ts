/**
 * The Google consent round trip.
 *
 * The student taps a link in Telegram, approves on Google, and comes back to a
 * page that tells them to return to the chat. What that round trip is *for* is
 * one string: the refresh token, which is the only durable half of the grant
 * and the only part written down.
 *
 * It rides on the HTTP server the runtime already creates — a Channel has to
 * own a long-lived process anyway, so there is no second service here and no
 * separate backend for the button UI.
 *
 * The consent page opens on the student's phone, so `PUBLIC_BASE_URL` has to be
 * somewhere their phone can reach (a tunnel during a demo) and has to match the
 * redirect URI registered in the Google console character for character.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import { CALENDAR_SCOPE, saveGoogleGrant } from "./calendar";
import * as services from "./index";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const START_PATH = "/oauth/google/start";
export const CALLBACK_PATH = "/oauth/google/callback";

/** A consent link is worth minutes, not hours. */
const STATE_TTL_MS = 10 * 60_000;

/**
 * Pending consent requests.
 *
 * The Telegram user id never travels in the URL — the state is an opaque token
 * that only this process can resolve, so a leaked link cannot be used to attach
 * somebody else's Google account to a student's row. In memory on purpose: an
 * unfinished consent is not worth surviving a restart.
 */
const pending = new Map<string, { telegramUserId: string; expiresAt: number }>();

function sweep(now = Date.now()): void {
  for (const [state, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(state);
  }
}

export function oauthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const baseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (!clientId || !clientSecret || !baseUrl) return undefined;
  return { clientId, clientSecret, baseUrl, redirectUri: `${baseUrl}${CALLBACK_PATH}` };
}

export const oauthConfigured = (): boolean => oauthConfig() !== undefined;

/**
 * The link a student taps, or undefined when Google is not configured.
 *
 * Minted per tap, so the card that carries it is only useful for ten minutes —
 * which is all the time anyone needs to approve a consent screen.
 */
export function connectUrl(telegramUserId: string): string | undefined {
  const config = oauthConfig();
  if (!config) return undefined;

  sweep();
  const state = randomUUID();
  pending.set(state, { telegramUserId, expiresAt: Date.now() + STATE_TTL_MS });

  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: CALENDAR_SCOPE,
    // Without both of these Google returns no refresh token on a repeat
    // consent, and the grant is then good for exactly one hour.
    access_type: "offline",
    prompt: "consent",
    state,
    include_granted_scopes: "true",
  }).toString();
  return url.toString();
}

/** Exchange the one-time code for the durable grant. */
async function exchange(
  code: string,
  config: NonNullable<ReturnType<typeof oauthConfig>>,
  fetchImpl: typeof fetch,
): Promise<{ refreshToken?: string; accessToken?: string }> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error(`Google code exchange failed: HTTP ${response.status}`);
  const body = (await response.json()) as { refresh_token?: string; access_token?: string };
  return { refreshToken: body.refresh_token, accessToken: body.access_token };
}

function page(res: ServerResponse, status: number, heading: string, detail: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Practice Agent</title>` +
      `<body style="font:16px/1.5 system-ui;margin:0;display:grid;place-items:center;height:100vh;text-align:center">` +
      `<div style="padding:24px;max-width:28rem"><h1 style="font-size:1.3rem">${heading}</h1>` +
      `<p style="color:#555">${detail}</p></div>`,
  );
}

/**
 * Handle a Google OAuth request.
 *
 * Returns true when it owned the request, so the caller knows not to pass it to
 * the Copilot listener.
 */
export async function handleOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const config = oauthConfig();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== START_PATH && url.pathname !== CALLBACK_PATH) return false;
  if (!config) {
    page(res, 503, "Not configured", "Google Calendar is switched off on this deployment.");
    return true;
  }

  // `/start` exists so a link can be handed out without a state on it; the
  // Telegram card normally sends people straight to Google.
  if (url.pathname === START_PATH) {
    const state = url.searchParams.get("s") ?? "";
    const entry = pending.get(state);
    if (!entry || entry.expiresAt <= Date.now()) {
      page(res, 400, "This link has expired", "Open Telegram and tap Connect again.");
      return true;
    }
    const target = connectUrl(entry.telegramUserId);
    res.writeHead(302, { Location: target ?? "/" });
    res.end();
    return true;
  }

  if (url.searchParams.get("error")) {
    page(res, 200, "Not connected", "You can connect your calendar any time from the menu.");
    return true;
  }

  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const entry = pending.get(state);
  pending.delete(state);

  if (!entry || entry.expiresAt <= Date.now() || !code) {
    page(res, 400, "This link has expired", "Open Telegram and tap Connect again.");
    return true;
  }

  const student = services.resolveCaller(db, entry.telegramUserId);
  if (!student) {
    page(res, 400, "Unknown student", "Link your Telegram account in the chat first.");
    return true;
  }

  try {
    const { refreshToken } = await exchange(code, config, fetchImpl);
    if (!refreshToken) {
      // Google withholds it when a grant already exists and `prompt=consent`
      // was not honoured — revoking the app's access and retrying fixes it.
      page(
        res,
        400,
        "Google did not send a durable grant",
        "Remove Practice Agent from your Google account permissions and try again.",
      );
      return true;
    }
    saveGoogleGrant(db, student.id, { refreshToken });
    page(
      res,
      200,
      "Calendar connected",
      "Your practices will appear in Google Calendar from now on. You can close this tab and go back to Telegram.",
    );
  } catch (error) {
    console.error("  google oauth:", error);
    page(res, 502, "Google could not be reached", "Try again in a moment.");
  }
  return true;
}

/** Test seam: how many consent requests are waiting. */
export const pendingCount = (): number => {
  sweep();
  return pending.size;
};
