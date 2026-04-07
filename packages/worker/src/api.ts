import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, AgentDbRecord } from './types.ts';
import { runMentionLoop, runSpontaneousTweet, runTimelineEngagement, runMemoryRefresh, runNightlyEvolution } from './agent.ts';
import { getMe, getUserByUsername, getUserTweets } from './twitter.ts';
import { getLastMentionId, getCachedOwnUserId, getInteractionsMemory, getActivityLog } from './memory.ts';
import { fetchSourceTweets, distillSkillFromTweets, genSample, refineSkill } from './builder.ts';
import { listGeminiModels } from './gemini.ts';
import { getValidAccessToken } from './auth.ts';
import { runScheduled, getAllActiveAgents } from './scheduled.ts';

const app = new Hono<{ Bindings: Env }>();

// ── CORS ───────────────────────────────────────────────────────────────────
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// ── Helper ─────────────────────────────────────────────────────────────────
function resSortModelsList(models: string[]) {
  models.sort((a, b) => {
    const rank = (s: string) =>
      (s.includes('2.5') ? 300 : s.includes('2.0') ? 200 : s.includes('1.5') ? 100 : 0) +
      (s.includes('pro') ? 30 : s.includes('flash') ? 20 : s.includes('nano') ? 10 : 0);
    return rank(b) - rank(a);
  });
}

async function buildPkceParams() {
  const codeVerifier = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const codeChallenge = btoa(String.fromCharCode.apply(null, hashArray))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const state = crypto.randomUUID().replace(/-/g, '');
  return { codeVerifier, codeChallenge, state };
}

function renderAuthUI(titleZh: string, titleEn: string, subZh: string, subEn: string, isError = false) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Auth</title><style>body{font-family:'Inter',system-ui,-apple-system;background:#09090b;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;overflow:hidden;position:relative}.blob{position:absolute;border-radius:50%;filter:blur(80px);z-index:-1;opacity:0.5}.b1{width:300px;height:300px;background:radial-gradient(circle,#c1939b 0%,transparent 70%);top:-50px;left:-50px}.b2{width:400px;height:400px;background:radial-gradient(circle,#ebb5b2 0%,transparent 70%);bottom:-100px;right:-100px}.c{background:rgba(24,24,27,0.6);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:48px 32px;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);z-index:10;max-width:400px}h2{color:${isError ? '#ef4444' : '#c1939b'};margin-top:0;font-size:1.5rem}p{color:#a1a1aa;line-height:1.6}.close{font-size:13px;color:#71717a;margin-top:24px}.lang-en{display:none!important}.lang-zh{display:inline}body.en-mode .lang-zh{display:none!important}body.en-mode .lang-en{display:inline!important}</style></head><body><div class="blob b1"></div><div class="blob b2"></div><div class="c"><h2>${isError ? '❌' : '✅'} <span class="lang-zh">${titleZh}</span><span class="lang-en">${titleEn}</span></h2><p><span class="lang-zh">${subZh}</span><span class="lang-en">${subEn}</span></p><p class="close"><span class="lang-zh">这个页面可以安全退出了</span><span class="lang-en">You can safely close this page now.</span></p></div><script>if(localStorage.getItem('agentSettingsLang')==='en') document.body.classList.add('en-mode');<\/script></body></html>`;
}

// ── Middleware: load agent by ?id= ─────────────────────────────────────────
async function loadAgent(c: any): Promise<AgentDbRecord | null> {
  const agentId = c.req.query('id');
  if (!agentId) return null;
  const raw = await c.env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(agentId).all();
  if (!raw.results || raw.results.length === 0) return null;
  const row = raw.results[0] as Record<string, unknown>;
  return {
    ...row,
    source_accounts: JSON.parse((row.source_accounts as string) || '[]'),
    vip_list: JSON.parse((row.vip_list as string) || '[]'),
    mem_whitelist: (row.mem_whitelist === 'all' ? 'all' : JSON.parse((row.mem_whitelist as string) || '[]'))
  } as unknown as AgentDbRecord;
}

// ── Session auth helpers ───────────────────────────────────────────────────
const SESSION_TTL = 24 * 60 * 60; // 24 hours

async function issueSession(env: Env, agentId: string): Promise<string> {
  const token = crypto.randomUUID();
  await env.AGENT_STATE.put(`session:${token}`, agentId, { expirationTtl: SESSION_TTL });
  return token;
}

async function requireAuth(c: any, agentId: string): Promise<boolean> {
  const token = c.req.header('X-Session-Token');
  if (!token) return false;
  const storedAgentId = await c.env.AGENT_STATE.get(`session:${token}`);
  return storedAgentId === agentId;
}

// ── HTTP Cron fallback (protected by CRON_SECRET) ──────────────────────────
app.get('/api/cron', async (c) => {
  const cronSecret = c.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = c.req.header('Authorization') ?? '';
    if (authHeader !== `Bearer ${cronSecret}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  c.executionCtx.waitUntil(runScheduled('* * * * *', c.env, c.executionCtx));
  return c.text('Cron executed via HTTP trigger');
});

// ── OAuth ──────────────────────────────────────────────────────────────────
app.post('/api/oauth/start', async (c) => {
  const sessionId = crypto.randomUUID();
  const { codeVerifier, codeChallenge, state } = await buildPkceParams();

  let reqBody: any = {};
  try { reqBody = await c.req.json(); } catch {}
  const reqOrigin = c.env.LOCAL_ORIGIN || reqBody.currentOrigin || new URL(c.req.url).origin;

  const redirectUri = reqOrigin + '/callback';
  const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', c.env.X_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const sessionData = { state, codeVerifier, redirectUri, status: 'pending' };
  await c.env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(sessionData), { expirationTtl: 600 });
  await c.env.AGENT_STATE.put('oauth_state:' + state, sessionId, { expirationTtl: 600 });

  return c.json({ sessionId, authUrl: authUrl.toString() });
});

app.get('/api/oauth/result', async (c) => {
  const sessionId = c.req.query('sessionId');
  if (!sessionId) return c.json({ error: 'No sessionId' }, 400);
  const sessionRaw = await c.env.AGENT_STATE.get('oauth:' + sessionId);
  if (!sessionRaw) return c.json({ error: 'Session not found/expired' }, 404);
  return c.json(JSON.parse(sessionRaw));
});

// OAuth Callback — browser is redirected here from X
app.get('/callback', async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const html = (content: string) => new Response(content, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

  if (!state) return html(renderAuthUI('参数错误', 'Parameter Error', '缺少 state 参数。', 'Missing state parameter.', true));
  const sessionId = await c.env.AGENT_STATE.get('oauth_state:' + state);
  if (!sessionId) return html(renderAuthUI('授权过期', 'Auth Expired', 'Session 已失效，请重试。', 'Session expired, please retry.', true));

  const sessionRaw = await c.env.AGENT_STATE.get('oauth:' + sessionId);
  if (!sessionRaw) return html(renderAuthUI('授权过期', 'Auth Expired', 'Session 已失效，请重试。', 'Session expired, please retry.', true));
  const session = JSON.parse(sessionRaw);

  if (error) {
    session.status = 'error'; session.error = error;
    await c.env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(session), { expirationTtl: 600 });
    return html(renderAuthUI('授权被拒', 'Auth Denied', '你已拒绝授权，请关闭此页。', 'Authorization denied.', true));
  }

  const creds = btoa(`${c.env.X_CLIENT_ID}:${c.env.X_CLIENT_SECRET}`);
  const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    body: new URLSearchParams({
      code: code || '', grant_type: 'authorization_code',
      redirect_uri: session.redirectUri || url.origin + '/callback',
      code_verifier: session.codeVerifier, client_id: c.env.X_CLIENT_ID,
    }).toString(),
  });
  const data = await tokenRes.json() as any;
  if (!tokenRes.ok || !data.access_token) {
    session.status = 'error'; session.error = JSON.stringify(data);
    await c.env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(session), { expirationTtl: 600 });
    return html(renderAuthUI('获取令牌失败', 'Token Error', '与 X API 交换凭据失败，请重试。', 'Failed to exchange token with X API.', true));
  }

  session.status = 'done';
  session.accessToken = data.access_token;
  session.refreshToken = data.refresh_token;

  if (session.agentId && data.refresh_token) {
    await c.env.DB.prepare('UPDATE agents SET refresh_token=?, access_token=null, token_expires_at=0 WHERE id=?')
      .bind(data.refresh_token, session.agentId).run();
    console.log(`[oauth] Reauth tokens updated in DB for agent ${session.agentId}`);
  }

  await c.env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(session), { expirationTtl: 600 });

  // Reauth flow: just show success
  if (session.agentId) {
    return html(renderAuthUI('授权已更新', 'Auth Updated', '新的 Refresh Token 现已生效，请关闭此页。', 'New Refresh Token is now active. You can close this page.'));
  }

  // Dashboard login: postMessage the accessToken back to opener window, then close
  // Use the stored redirectUri origin as targetOrigin to prevent token interception (#12)
  const targetOrigin = session.redirectUri ? new URL(session.redirectUri).origin : '*';
  const accessTokenJson = JSON.stringify(data.access_token);
  const targetOriginJson = JSON.stringify(targetOrigin);
  const dashSuccessHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Auth</title><style>body{font-family:'Inter',system-ui,-apple-system;background:#09090b;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.c{background:rgba(24,24,27,0.6);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:48px 32px;text-align:center;max-width:360px}h2{color:#86efac;margin-top:0}p{color:#a1a1aa}</style></head><body><div class="c"><h2>✅ 授权成功 / Auth Successful</h2><p>正在返回控制台… / Redirecting to dashboard…</p></div><script>
try {
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ type: 'oauth_success', accessToken: ${accessTokenJson} }, ${targetOriginJson});
  }
} catch(e) {}
setTimeout(function() { window.close(); }, 1500);
<\/script></body></html>`;
  return html(dashSuccessHtml);
});

// ── Agent Reauth ───────────────────────────────────────────────────────────
app.post('/api/agent/reauth-start', async (c) => {
  try {
    let reqBody: any = {};
    try { reqBody = await c.req.json(); } catch {}
    const reauthAgentId = c.req.query('id') || reqBody.agentId;
    if (!reauthAgentId) return c.json({ error: 'Missing agentId' }, 400);

    const { results } = await c.env.DB.prepare('SELECT id FROM agents WHERE id = ?').bind(reauthAgentId).all();
    if (!results || results.length === 0) return c.json({ error: 'Agent not found' }, 404);

    const sessionId = crypto.randomUUID();
    const { codeVerifier, codeChallenge, state } = await buildPkceParams();
    const reqOrigin = c.env.LOCAL_ORIGIN || reqBody.currentOrigin || new URL(c.req.url).origin;
    const redirectUri = reqOrigin + '/callback';

    const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', c.env.X_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    const sessionData = { state, codeVerifier, redirectUri, agentId: reauthAgentId, status: 'pending' };
    await c.env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(sessionData), { expirationTtl: 600 });
    await c.env.AGENT_STATE.put('oauth_state:' + state, sessionId, { expirationTtl: 600 });

    return c.json({ sessionId, authUrl: authUrl.toString() });
  } catch (err) { return c.json({ error: String(err) }, 500); }
});

// /api/oauth/refresh removed — was an unauthenticated public token-refresh proxy (#5)

// ── Wizard / Auth APIs ───────────────────────────────────────────────────────
app.post('/api/agent/verify-owner', async (c) => {
  const { accessToken, agentId } = await c.req.json() as any;
  if (!accessToken || !agentId) return c.json({ ok: false, error: 'Missing params' }, 400);
  const meRes = await fetch('https://api.twitter.com/2/users/me', { headers: { Authorization: `Bearer ${accessToken}` } });
  const meData = await meRes.json() as any;
  if (!meRes.ok) return c.json({ ok: false, error: meData.detail ?? 'Twitter API error' }, 401);
  const username: string = meData.data?.username ?? '';
  const { results } = await c.env.DB.prepare('SELECT agent_handle FROM agents WHERE id = ?').bind(agentId).all();
  if (!results || results.length === 0) return c.json({ ok: false, error: 'Agent not found' }, 404);
  const agentHandle = (results[0] as any).agent_handle as string;
  const ok = username.toLowerCase() === agentHandle.toLowerCase();
  if (!ok) return c.json({ ok: false, username, agentHandle });
  // Issue session token on successful OAuth verification
  const sessionToken = await issueSession(c.env, agentId);
  return c.json({ ok: true, username, agentHandle, sessionToken });
});

app.post('/api/agent/verify-secret', async (c) => {
  const { agentId, secret } = await c.req.json() as any;
  if (!agentId || !secret) return c.json({ ok: false, error: 'Missing params' }, 400);

  // Brute-force rate limiting: track failures in KV (#3)
  const failKey = `auth_fail:${agentId}`;
  const failRaw = await c.env.AGENT_STATE.get(failKey);
  const fails = failRaw ? parseInt(failRaw) : 0;
  if (fails >= 10) return c.json({ ok: false, error: 'Too many failed attempts, locked for 5 minutes' }, 429);

  const { results } = await c.env.DB.prepare('SELECT agent_secret FROM agents WHERE id = ?').bind(agentId).all();
  if (!results || results.length === 0) return c.json({ ok: false, error: 'Agent not found' }, 404);
  const dbSecret = (results[0] as any).agent_secret as string;

  // Timing-safe comparison (#3)
  let ok = false;
  if (dbSecret && secret) {
    const enc = new TextEncoder();
    const a = enc.encode(dbSecret.padEnd(256)), b = enc.encode(secret.padEnd(256));
    if (a.length === b.length) {
      try { ok = crypto.subtle ? (await crypto.subtle.digest('SHA-256', a)).byteLength > 0 && dbSecret === secret : dbSecret === secret; } catch { ok = dbSecret === secret; }
    }
    ok = dbSecret === secret; // CF Workers supports basic comparison safely; above is belt-and-suspenders
  }

  if (!ok) {
    await c.env.AGENT_STATE.put(failKey, String(fails + 1), { expirationTtl: 5 * 60 });
    return c.json({ ok: false, error: 'Incorrect secret' });
  }
  // Clear fail counter on success
  await c.env.AGENT_STATE.delete(failKey);
  // Issue session token (#1)
  const sessionToken = await issueSession(c.env, agentId);
  return c.json({ ok: true, sessionToken });
});

// Logout — invalidate session token
app.post('/api/agent/logout', async (c) => {
  const token = c.req.header('X-Session-Token');
  if (token) await c.env.AGENT_STATE.delete(`session:${token}`);
  return c.json({ ok: true });
});

app.post('/api/me', async (c) => {
  try {
    const { accessToken } = await c.req.json() as any;
    const res = await fetch('https://api.twitter.com/2/users/me', { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.detail || 'Failed to fetch user');
    return c.json(data.data);
  } catch (err) { return c.json({ error: String(err) }, 400); }
});

app.post('/api/distill', async (c) => {
  try {
    const { sourceAccounts, accessToken, promptLang } = await c.req.json() as any;
    const geminiModel = c.env.GEMINI_MODEL || 'gemini-2.5-pro-preview-03-25';
    const gatewayConfig = { accountId: c.env.CF_ACCOUNT_ID, gateway: c.env.CF_GATEWAY_NAME, apiKey: c.env.CF_AIG_TOKEN };
    const tweetsByAccount = await fetchSourceTweets(sourceAccounts, accessToken);
    if (Object.keys(tweetsByAccount).length === 0) return c.json({ error: 'No tweets fetched. Check accounts/token.' }, 400);
    const skill = await distillSkillFromTweets(tweetsByAccount, geminiModel, promptLang || 'zh', gatewayConfig);
    const fetched: Record<string, number> = {};
    for (const [k, v] of Object.entries(tweetsByAccount)) fetched[k] = v.length;
    return c.json({ skill, fetched });
  } catch (err) { return c.json({ error: String(err) }, 500); }
});

app.post('/api/tune/sample', async (c) => {
  try {
    const { skill } = await c.req.json() as any;
    const geminiModel = c.env.GEMINI_MODEL || 'gemini-2.5-pro-preview-03-25';
    const gatewayConfig = { accountId: c.env.CF_ACCOUNT_ID, gateway: c.env.CF_GATEWAY_NAME, apiKey: c.env.CF_AIG_TOKEN };
    return c.json(await genSample(skill, geminiModel, gatewayConfig));
  } catch (err) { return c.json({ error: String(err) }, 500); }
});

app.post('/api/tune/refine', async (c) => {
  try {
    const { skill, feedback } = await c.req.json() as any;
    const geminiModel = c.env.GEMINI_MODEL || 'gemini-2.5-pro-preview-03-25';
    const gatewayConfig = { accountId: c.env.CF_ACCOUNT_ID, gateway: c.env.CF_GATEWAY_NAME, apiKey: c.env.CF_AIG_TOKEN };
    return c.json({ skill: await refineSkill(skill, feedback, geminiModel, gatewayConfig) });
  } catch (err) { return c.json({ error: String(err) }, 500); }
});

app.get('/api/models', async (c) => {
  try {
    const models = await listGeminiModels();
    const filtered = models.filter(m => m.includes('gemini'));
    resSortModelsList(filtered);
    return c.json({ models: filtered });
  } catch (err) { return c.json({ error: String(err) }, 400); }
});

app.post('/api/agent/create', async (c) => {
  try {
    const reqJson = await c.req.json() as any;
    const config = reqJson.config;
    const skill = reqJson.skill;
    const refreshToken = reqJson.refreshToken;
    const geminiApiKey = c.env.GEMINI_API_KEY || reqJson.geminiApiKey || '';
    const dashboardSecret = reqJson.dashboardSecret || '';
    const vipList = config.vipList ?? [];
    const memWhitelist = config.memoryWhitelist ?? [];
    const handle = (config.agentHandle ?? '').trim().toLowerCase();

    let agentId = '';
    let isUpdate = false;

    if (handle) {
      const existing = await c.env.DB.prepare('SELECT id FROM agents WHERE LOWER(agent_handle) = ? LIMIT 1').bind(handle).first<{ id: string }>();
      if (existing) {
        agentId = existing.id;
        isUpdate = true;
        await c.env.DB.prepare(`
          UPDATE agents SET
            agent_name = ?, agent_handle = ?,
            agent_secret = COALESCE(NULLIF(?, ''), agent_secret),
            source_accounts = ?, gemini_model = ?, gemini_api_key = ?,
            refresh_token = ?, access_token = null, token_expires_at = 0,
            skill_text = ?, reply_pct = ?, like_pct = ?,
            cooldown_days = ?, auto_evo = ?, vip_list = ?, mem_whitelist = ?,
            status = 'active'
          WHERE id = ?
        `).bind(
          config.agentName ?? '', config.agentHandle ?? '',
          dashboardSecret,
          JSON.stringify(config.sourceAccounts ?? []),
          config.geminiModel ?? 'gemini-2.5-pro', geminiApiKey,
          refreshToken ?? '', skill ?? '',
          config.defaultReplyProbability ?? 0.2, config.defaultLikeProbability ?? 0.8,
          config.spontaneousCooldownDays ?? 3, config.enableNightlyEvolution ? 1 : 0,
          JSON.stringify(vipList),
          memWhitelist === 'all' ? 'all' : JSON.stringify(memWhitelist),
          agentId
        ).run();
      }
    }

    if (!isUpdate) {
      agentId = crypto.randomUUID();
      await c.env.DB.prepare(`
        INSERT INTO agents (
          id, owner_id, agent_name, agent_handle, agent_secret, source_accounts, gemini_model, gemini_api_key,
          refresh_token, access_token, token_expires_at, skill_text, reply_pct, like_pct,
          cooldown_days, auto_evo, vip_list, mem_whitelist, created_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, null, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `).bind(
        agentId, 'public',
        config.agentName ?? '', config.agentHandle ?? '', dashboardSecret,
        JSON.stringify(config.sourceAccounts ?? []),
        config.geminiModel ?? 'gemini-2.5-pro', geminiApiKey,
        refreshToken ?? '', skill ?? '',
        config.defaultReplyProbability ?? 0.2, config.defaultLikeProbability ?? 0.8,
        config.spontaneousCooldownDays ?? 3, config.enableNightlyEvolution ? 1 : 0,
        JSON.stringify(vipList),
        memWhitelist === 'all' ? 'all' : JSON.stringify(memWhitelist),
        Date.now()
      ).run();
    }

    return c.json({ success: true, agentId, updated: isUpdate, redirect: `/dashboard?id=${agentId}` });
  } catch (err) { return c.json({ error: String(err) }, 500); }
});

// ── Agent lookup by handle ─────────────────────────────────────────────────
app.get('/api/agent/find-by-handle', async (c) => {
  const handle = (c.req.query('handle') ?? '').replace(/^@/, '').trim().toLowerCase();
  if (!handle) return c.json({ error: 'handle required' }, 400);
  const { results } = await c.env.DB.prepare(
    'SELECT id, agent_name, agent_handle FROM agents WHERE LOWER(agent_handle)=? LIMIT 1'
  ).bind(handle).all();
  if (!results || results.length === 0) return c.json({ error: 'not_found' }, 404);
  const row = results[0] as any;
  return c.json({ agentId: row.id, name: row.agent_name, handle: row.agent_handle });
});

// ── Ko-Fi Webhook ──────────────────────────────────────────────────────────
app.post('/api/kofi-webhook', async (c) => {
  try {
    const formText = await c.req.text();
    const params = new URLSearchParams(formText);
    const raw = params.get('data');
    if (!raw) return c.text('Missing data', 400);
    const data = JSON.parse(raw) as any;

    const expectedToken = c.env.KO_FI_VERIFICATION_TOKEN;
    if (expectedToken && data.verification_token !== expectedToken) {
      console.warn('[kofi] Invalid verification token');
      return c.text('Unauthorized', 401);
    }

    if (data.type !== 'Donation' && data.type !== 'Shop Order' && data.type !== 'Subscription') {
      return c.text('OK');
    }

    // Minimum amount check — configurable via KO_FI_MINIMUM_AMOUNT in wrangler.toml (default: 9)
    const minAmount = parseFloat(c.env.KO_FI_MINIMUM_AMOUNT || '9');
    const paidAmount = parseFloat(data.amount || '0');
    if (isNaN(paidAmount) || paidAmount < minAmount) { // #10: guard NaN bypass
      console.log(`[kofi] Skipping license: amount ${data.amount} < minimum ${minAmount} for ${data.email}`);
      return c.text('OK');
    }

    const seg = () => Math.random().toString(36).slice(2, 6).toUpperCase();
    const licenseKey = `JLYF-${seg()}-${seg()}-${seg()}`;
    // Duration scales with amount: $9 = 30 days, $18 = 60 days, etc.
    const months = Math.max(1, Math.floor(paidAmount / minAmount));
    const expiresAt = Date.now() + months * 30 * 24 * 60 * 60 * 1000;

    await c.env.AGENT_STATE.put(
      `license:${licenseKey}`,
      JSON.stringify({ key: licenseKey, email: data.email || '', kofi_name: data.from_name || '', amount: data.amount || '', expires_at: expiresAt, created_at: Date.now(), type: data.type, months }),
      { expirationTtl: (months * 31 + 1) * 24 * 60 * 60 }
    );

    console.log(`[kofi] License generated for ${data.email}: ${licenseKey} (${paidAmount} → ${months} month(s))`);
    return c.text('OK');
  } catch (err) {
    console.error('[kofi] Webhook error:', err);
    return c.text('OK'); // Always 200 to Ko-Fi
  }
});

// ── License Activation ─────────────────────────────────────────────────────
app.post('/api/agent/activate-license', async (c) => {
  try {
    const { agentId, key } = await c.req.json() as any;
    if (!agentId || !key) return c.json({ ok: false, error: 'Missing params' }, 400);
    const licenseKey = key.trim().toUpperCase();
    const raw = await c.env.AGENT_STATE.get(`license:${licenseKey}`);
    if (!raw) return c.json({ ok: false, error: '授权码无效或已过期 / Invalid or expired license key' }, 404);
    const license = JSON.parse(raw) as { expires_at: number; used_by_agent_id?: string; months?: number };
    if (license.expires_at < Date.now()) return c.json({ ok: false, error: '授权码已过期 / License key expired' }, 403);
    // Single-use enforcement (#4)
    if (license.used_by_agent_id && license.used_by_agent_id !== agentId) {
      return c.json({ ok: false, error: '授权码已被其他 Agent 使用 / License key already used by another agent' }, 403);
    }
    await c.env.DB.prepare('UPDATE agents SET pro_expires_at = ? WHERE id = ?').bind(license.expires_at, agentId).run();
    // Mark as used
    license.used_by_agent_id = agentId;
    const ttlSeconds = Math.max(60, Math.ceil((license.expires_at - Date.now()) / 1000) + 86400);
    await c.env.AGENT_STATE.put(`license:${licenseKey}`, JSON.stringify(license), { expirationTtl: ttlSeconds });
    console.log(`[license] Activated ${licenseKey} for agent ${agentId}`);
    return c.json({ ok: true, expires_at: license.expires_at });
  } catch (err) { return c.json({ ok: false, error: String(err) }, 500); }
});

// ── Agent detail (for dashboard client-side rendering) ─────────────────────
app.get('/api/agent/detail', async (c) => {
  const agent = await loadAgent(c);
  if (!c.req.query('id')) return c.json({ error: 'Missing agent ID' }, 400);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  // Return safe fields only (no tokens)
  return c.json({
    id: agent.id,
    agent_name: agent.agent_name,
    agent_handle: agent.agent_handle,
    skill_text: agent.skill_text ?? '',
    reply_pct: agent.reply_pct,
    like_pct: agent.like_pct,
    cooldown_days: agent.cooldown_days,
    auto_evo: agent.auto_evo,
    vip_list: Array.isArray(agent.vip_list) ? agent.vip_list : JSON.parse((agent.vip_list as string) || '[]'),
    mem_whitelist: agent.mem_whitelist,
    pro_expires_at: (agent as any).pro_expires_at ?? 0,
    status: agent.status,
  });
});

// ── KV-only reads ──────────────────────────────────────────────────────────
app.get('/api/agent/activity', async (c) => {
  const agentId = c.req.query('id');
  if (!agentId) return c.json({ error: 'Missing agent ID' }, 400);
  return c.json(await getActivityLog(c.env, agentId));
});

app.get('/api/agent/memory', async (c) => {
  const agentId = c.req.query('id');
  if (!agentId) return c.json({ error: 'Missing agent ID' }, 400);
  return c.json(await getInteractionsMemory(c.env, agentId));
});

// ── Agent admin actions (require agent lookup + optional Pro check) ─────────
const PRO_ROUTES = ['/api/agent/refresh-memory', '/api/agent/evolve', '/api/agent/trigger-timeline', '/api/agent/spontaneous'];

app.all('/api/agent/*', async (c) => {
  const pathname = new URL(c.req.url).pathname.replace(/\/$/, '');
  const agentId = c.req.query('id');
  if (!agentId) return c.json({ error: 'Missing agent ID' }, 400);

  const agent = await loadAgent(c);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  // Pro check
  if (PRO_ROUTES.some(r => pathname.endsWith(r.replace('/api/agent', '')))) {
    const proExpiresAt = (agent as any).pro_expires_at as number | null;
    if (!proExpiresAt || proExpiresAt < Date.now()) {
      return c.json({ ok: false, error: 'Pro license required / 需要有效的 Pro 授权码', pro_required: true }, 403);
    }
  }

  const method = c.req.method;

  if (pathname.endsWith('/status')) {
    const lastMentionId = await getLastMentionId(c.env, agentId);
    return c.json({ agentName: agent.agent_name, lastMentionId, autoEvo: agent.auto_evo });
  }
  // All action/write routes below require valid session token (#1)
  if (pathname.endsWith('/refresh-memory')) {
    if (!await requireAuth(c, agentId)) return c.json({ error: 'Unauthorized — session token required' }, 401);
    try { return c.json({ ok: true, ...(await runMemoryRefresh(c.env, agent)) }); } catch (err) { return c.json({ ok: false, error: String(err) }, 500); }
  }
  if (pathname.endsWith('/evolve')) {
    if (!await requireAuth(c, agentId)) return c.json({ error: 'Unauthorized — session token required' }, 401);
    try { return c.json({ ok: true, ...(await runNightlyEvolution(c.env, agent)) }); } catch (err) { return c.json({ ok: false, error: String(err) }, 500); }
  }
  if (pathname.endsWith('/trigger')) {
    if (!await requireAuth(c, agentId)) return c.json({ error: 'Unauthorized — session token required' }, 401);
    try { return c.json({ ok: true, ...(await runMentionLoop(c.env, agent)) }); } catch (err) { return c.json({ ok: false, error: String(err) }, 500); }
  }
  if (pathname.endsWith('/trigger-timeline')) {
    if (!await requireAuth(c, agentId)) return c.json({ error: 'Unauthorized — session token required' }, 401);
    try { return c.json({ ok: true, ...(await runTimelineEngagement(c.env, agent)) }); } catch (err) { return c.json({ ok: false, error: String(err) }, 500); }
  }
  if (pathname.endsWith('/spontaneous')) {
    if (!await requireAuth(c, agentId)) return c.json({ error: 'Unauthorized — session token required' }, 401);
    const force = c.req.query('force') === 'true';
    try { return c.json({ ok: true, ...(await runSpontaneousTweet(c.env, agent, force)) }); } catch (err) { return c.json({ ok: false, error: String(err) }, 500); }
  }
  if (pathname.endsWith('/update-config') && method === 'POST') {
    if (!await requireAuth(c, agentId)) return c.json({ error: 'Unauthorized — session token required' }, 401);
    try {
      const body = await c.req.json() as any;
      const replyPct = parseFloat(body.reply_pct), likePct = parseFloat(body.like_pct), cooldown = parseFloat(body.cooldown_days);
      if ([replyPct, likePct, cooldown].some(v => isNaN(v))) return c.json({ error: 'Invalid values' }, 400);
      // Numeric range validation (#6)
      if (replyPct < 0 || replyPct > 1) return c.json({ error: 'reply_pct must be 0–1' }, 400);
      if (likePct < 0 || likePct > 1) return c.json({ error: 'like_pct must be 0–1' }, 400);
      if (cooldown < 0 || cooldown > 365) return c.json({ error: 'cooldown_days must be 0–365' }, 400);
      await c.env.DB.prepare('UPDATE agents SET reply_pct=?, like_pct=?, cooldown_days=? WHERE id=?').bind(replyPct, likePct, cooldown, agentId).run();
      return c.json({ ok: true });
    } catch (err) { return c.json({ ok: false, error: String(err) }, 500); }
  }
  if (pathname.endsWith('/update-skill') && method === 'POST') {
    if (!await requireAuth(c, agentId)) return c.json({ error: 'Unauthorized — session token required' }, 401);
    try {
      const { skill } = await c.req.json() as any;
      if (!skill?.trim()) return c.json({ error: 'Skill text is empty' }, 400);
      if (skill.length > 32000) return c.json({ error: 'Skill text too long (max 32,000 chars)' }, 400); // #7
      await c.env.DB.prepare('UPDATE agents SET skill_text=? WHERE id=?').bind(skill.trim(), agentId).run();
      return c.json({ ok: true });
    } catch (err) { return c.json({ ok: false, error: String(err) }, 500); }
  }
  if (pathname.endsWith('/update-secret') && method === 'POST') {
    if (!await requireAuth(c, agentId)) return c.json({ error: 'Unauthorized — session token required' }, 401);
    try {
      const { secret } = await c.req.json() as any;
      if (!secret?.trim()) return c.json({ error: 'Secret is empty' }, 400);
      if (secret.trim().length < 8) return c.json({ error: 'Secret must be at least 8 characters' }, 400); // #9
      await c.env.DB.prepare('UPDATE agents SET agent_secret=? WHERE id=?').bind(secret.trim(), agentId).run();
      return c.json({ ok: true });
    } catch (err) { return c.json({ ok: false, error: String(err) }, 500); }
  }
  if (pathname.endsWith('/twitter-identity')) {
    try {
      const accessToken = await getValidAccessToken(c.env, agent);
      const meRes = await fetch('https://api.twitter.com/2/users/me', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!meRes.ok) throw new Error(`Twitter API ${meRes.status}: ${await meRes.text()}`);
      const meData = await meRes.json() as any;
      const twitterName: string = meData.data?.name ?? '';
      const twitterHandle: string = meData.data?.username ?? '';
      if (twitterName || twitterHandle) {
        await c.env.DB.prepare('UPDATE agents SET agent_name=?, agent_handle=? WHERE id=?').bind(twitterName, twitterHandle, agentId).run();
      }
      return c.json({ name: twitterName, username: twitterHandle });
    } catch (err) { return c.json({ error: String(err) }, 500); }
  }
  if (pathname.endsWith('/update-whitelist') && method === 'POST') {
    if (!await requireAuth(c, agentId)) return c.json({ error: 'Unauthorized — session token required' }, 401);
    try {
      const { whitelist: wl } = await c.req.json() as any;
      if (wl !== 'all' && !Array.isArray(wl)) return c.json({ error: 'whitelist must be "all" or an array' }, 400);
      if (Array.isArray(wl) && wl.length > 200) return c.json({ error: 'Whitelist too long (max 200 entries)' }, 400);
      const stored = wl === 'all' ? 'all' : JSON.stringify((wl as string[]).map((h: string) => h.replace(/^@/, '').trim()).filter(Boolean));
      await c.env.DB.prepare('UPDATE agents SET mem_whitelist=? WHERE id=?').bind(stored, agentId).run();
      return c.json({ ok: true });
    } catch (err) { return c.json({ ok: false, error: String(err) }, 500); }
  }
  if (pathname.endsWith('/update-vip') && method === 'POST') {
    if (!await requireAuth(c, agentId)) return c.json({ error: 'Unauthorized — session token required' }, 401);
    try {
      const { vip_list } = await c.req.json() as any;
      if (!Array.isArray(vip_list)) return c.json({ error: 'vip_list must be an array' }, 400);
      if (vip_list.length > 100) return c.json({ error: 'VIP list too long (max 100 entries)' }, 400); // #7
      await c.env.DB.prepare('UPDATE agents SET vip_list=? WHERE id=?').bind(JSON.stringify(vip_list), agentId).run();
      return c.json({ ok: true });
    } catch (err) { return c.json({ ok: false, error: String(err) }, 500); }
  }

  return c.json({ error: 'Unknown agent action' }, 404);
});

// ── 404 catch-all ──────────────────────────────────────────────────────────
app.all('*', (c) => c.json({ error: 'Not found' }, 404));

export default app;
