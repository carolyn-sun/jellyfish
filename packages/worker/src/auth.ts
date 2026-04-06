import type { Env, XTokenResponse, AgentDbRecord } from './types.ts';

const TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';

// Refresh a minute before actual expiry to avoid races
const EXPIRY_BUFFER_MS = 60_000;

export async function refreshAccessToken(env: Env, agent: AgentDbRecord, refreshToken: string): Promise<string> {
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

  const accessToken = json.access_token;
  const newRefreshToken = json.refresh_token ?? refreshToken;
  const expiresAt = Date.now() + json.expires_in * 1000 - EXPIRY_BUFFER_MS;

  // Update in DB dynamically
  await env.DB.prepare(
    `UPDATE agents SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?`
  ).bind(accessToken, newRefreshToken, expiresAt, agent.id).run();

  // Update in-memory record so subsequent calls in the same event use it safely
  agent.access_token = accessToken;
  agent.refresh_token = newRefreshToken;
  agent.token_expires_at = expiresAt;

  console.log(`[auth] Tokens refreshed and saved for agent ${agent.id}`);
  return accessToken;
}

export async function getValidAccessToken(env: Env, agent: AgentDbRecord): Promise<string> {
  // If we have an access token and it's not expired
  if (agent.access_token && agent.token_expires_at && Date.now() < agent.token_expires_at) {
    return agent.access_token;
  }

  console.log(`[auth] Access token expired or missing for agent ${agent.id}, refreshing...`);
  return refreshAccessToken(env, agent, agent.refresh_token);
}
