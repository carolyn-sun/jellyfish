import type { Env, XTokenResponse, StoredTokens } from './types.ts';
import { getStoredTokens, saveTokens } from './memory.ts';

const TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';

// Refresh a minute before actual expiry to avoid races
const EXPIRY_BUFFER_MS = 60_000;

// ─── Bootstrap: import the initial refresh token from secrets ──────────────────
// On first run, there are no tokens in KV yet.
// We bootstrap from X_REFRESH_TOKEN secret and exchange it immediately.
async function bootstrap(env: Env): Promise<StoredTokens> {
  console.log('[auth] Bootstrapping tokens from secret...');
  return refreshAccessToken(env, env.X_REFRESH_TOKEN);
}

// ─── Use refresh_token to get a new access_token ──────────────────────────────
async function refreshAccessToken(env: Env, refreshToken: string): Promise<StoredTokens> {
  const credentials = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.X_CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[auth] Token refresh failed ${res.status}: ${body}`);
  }

  const json = (await res.json()) as XTokenResponse;

  const tokens: StoredTokens = {
    accessToken: json.access_token,
    // X may or may not rotate the refresh token; fall back to existing one
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000 - EXPIRY_BUFFER_MS,
  };

  await saveTokens(env, tokens);
  console.log('[auth] Tokens refreshed and saved.');
  return tokens;
}

// ─── Main export: get a valid access token ────────────────────────────────────
export async function getValidAccessToken(env: Env): Promise<string> {
  let tokens = await getStoredTokens(env);

  if (!tokens) {
    tokens = await bootstrap(env);
    return tokens.accessToken;
  }

  if (Date.now() >= tokens.expiresAt) {
    console.log('[auth] Access token expired, refreshing...');
    try {
      tokens = await refreshAccessToken(env, tokens.refreshToken);
    } catch (e) {
      console.warn('[auth] Refresh failed with cached token, falling back to bootstrap from env secret...', e);
      tokens = await bootstrap(env);
    }
  }

  return tokens.accessToken;
}
