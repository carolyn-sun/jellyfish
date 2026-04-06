import type { Env, AgentDbRecord } from './types.ts';
import { runMentionLoop, runSpontaneousTweet, runTimelineEngagement, runMemoryRefresh, runNightlyEvolution } from './agent.ts';
import { getMe, getUserByUsername, getUserTweets } from './twitter.ts';
import { getLastMentionId, getCachedOwnUserId, getInteractionsMemory, getActivityLog } from './memory.ts';
import { fetchSourceTweets, distillSkillFromTweets, genSample, refineSkill } from './builder.ts';
import { listGeminiModels } from './gemini.ts';
import { getValidAccessToken } from './auth.ts';

async function getAllActiveAgents(env: Env): Promise<AgentDbRecord[]> {
  const { results } = await env.DB.prepare('SELECT * FROM agents WHERE status = "active"').all();
  if (!results) return [];
  return results.map(row => ({
    ...row,
    source_accounts: JSON.parse((row.source_accounts as string) || '[]'),
    vip_list: JSON.parse((row.vip_list as string) || '[]'),
    mem_whitelist: (row.mem_whitelist === 'all' ? 'all' : JSON.parse((row.mem_whitelist as string) || '[]'))
  })) as unknown as AgentDbRecord[];
}

async function runScheduled(cron: string | undefined, env: Env, ctx: ExecutionContext): Promise<void> {
  console.log(`[worker] Cron triggered globally: ${cron}`);

  const agents = await getAllActiveAgents(env);
    console.log(`[worker] Executing for ${agents.length} active agents.`);

    const now = new Date();
    const hours = now.getUTCHours();
    const mins = now.getUTCMinutes();

    const isHourly = mins === 0;
    const isSpontaneousTime = hours === 12 && mins === 30;
    const isMemoryTime = hours % 6 === 0 && mins === 0;
    const isNightlyEvo = hours === 3 && mins === 0;

    for (const agent of agents) {
      if (cron === '* * * * *' || !cron) {
        ctx.waitUntil((async () => {
          for (let i = 0; i < 4; i++) {
            const runStart = Date.now();
            await runMentionLoop(env, agent).catch(e => console.error(`[worker] mention loop error for ${agent.id}:`, e));
            const elapsed = Date.now() - runStart;
            const remaining = 15000 - elapsed;
            if (i < 3 && remaining > 0) {
              await new Promise(r => setTimeout(r, remaining));
            }
          }
        })());
      }
      
      if (isHourly || cron === '0 * * * *') {
        ctx.waitUntil(runTimelineEngagement(env, agent).catch(e => console.error(`[worker] timeline error for ${agent.id}:`, e)));
      }
      if (isSpontaneousTime || cron === '30 12 * * *') {
        ctx.waitUntil(runSpontaneousTweet(env, agent).catch(e => console.error(`[worker] spontaneous error for ${agent.id}:`, e)));
      }
      if (isMemoryTime || cron === '0 */6 * * *') {
        ctx.waitUntil(runMemoryRefresh(env, agent).catch(e => console.error(`[worker] memory refresh error for ${agent.id}:`, e)));
      }
      if (isNightlyEvo || cron === '0 3 * * *') {
        ctx.waitUntil(runNightlyEvolution(env, agent).catch(e => console.error(`[worker] nightly evolution error for ${agent.id}:`, e)));
      }
    }
  }

export default {
  // ── Cron Triggers ────────────────────────────────────────────────────────────
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return runScheduled(controller.cron, env, ctx);
  },

  // ── HTTP Handler ──────────────────────────────────────────────────────────────
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname.replace(/\/$/, '') || '/';

    // Fallback Ping Endpoint (if Cloudflare account hit max 5 crons limit)
    if (pathname === '/api/cron') {
      ctx.waitUntil(runScheduled('* * * * *', env, ctx));
      return new Response('Cron executed via HTTP trigger', { status: 200 });
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    }

    const corsHeaders = { "Access-Control-Allow-Origin": "*" };
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

    // ── Wizard API Endpoints ───────────────────────────────────────────────────

    // Replaced /api/auth-check — dashboard now uses Twitter OAuth to verify ownership
    if (pathname === '/api/agent/verify-owner' && method === 'POST') {
      const body = await request.json() as any;
      const { accessToken, agentId } = body;
      if (!accessToken || !agentId) return json({ ok: false, error: 'Missing params' }, 400);
      // Fetch the authed user from Twitter
      const meRes = await fetch('https://api.twitter.com/2/users/me', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const meData = await meRes.json() as any;
      if (!meRes.ok) return json({ ok: false, error: meData.detail ?? 'Twitter API error' }, 401);
      const username: string = meData.data?.username ?? '';
      // Fetch the agent from DB and compare handle
      const { results } = await env.DB.prepare('SELECT agent_handle FROM agents WHERE id = ?').bind(agentId).all();
      if (!results || results.length === 0) return json({ ok: false, error: 'Agent not found' }, 404);
      const agentHandle = (results[0] as any).agent_handle as string;
      const ok = username.toLowerCase() === agentHandle.toLowerCase();
      return json({ ok, username, agentHandle });
    }

    if (pathname === '/api/agent/verify-secret' && method === 'POST') {
      const body = await request.json() as any;
      const { agentId, secret } = body;
      if (!agentId || !secret) return json({ ok: false, error: 'Missing params' }, 400);
      const { results } = await env.DB.prepare('SELECT agent_secret FROM agents WHERE id = ?').bind(agentId).all();
      if (!results || results.length === 0) return json({ ok: false, error: 'Agent not found' }, 404);
      const dbSecret = (results[0] as any).agent_secret as string;
      const ok = (dbSecret && dbSecret === secret);
      return json({ ok });
    }

    if (pathname === '/api/oauth/start' && method === 'POST') {
      const sessionId = crypto.randomUUID();
      const codeVerifier = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''); // 64 chars
      
      const encoder = new TextEncoder();
      const data = encoder.encode(codeVerifier);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const codeChallenge = btoa(String.fromCharCode.apply(null, hashArray)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      
      const state = crypto.randomUUID().replace(/-/g, '');

      let reqBody: any = {};
      try { reqBody = await request.clone().json(); } catch(e) {}

      // env.LOCAL_ORIGIN is set in .dev.vars only — Wrangler dev rewrites request.url/Origin/Referer
      // to match the configured custom domain (jellyfishai.org), so we must use an env var or
      // the payload-supplied origin as the only tamper-proof escape hatches.
      const reqOrigin = env.LOCAL_ORIGIN || reqBody.currentOrigin || url.origin;

      const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', env.X_CLIENT_ID);
      const redirectUri = reqOrigin + '/callback';
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      const sessionData = { state, codeVerifier, redirectUri, status: 'pending' };
      await env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(sessionData), { expirationTtl: 600 });
      await env.AGENT_STATE.put('oauth_state:' + state, sessionId, { expirationTtl: 600 });
      
      return json({ sessionId, authUrl: authUrl.toString() });
    }

    if (pathname === '/api/oauth/result' && method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return json({ error: 'No sessionId' }, 400);
      const sessionRaw = await env.AGENT_STATE.get('oauth:' + sessionId);
      if (!sessionRaw) return json({ error: 'Session not found/expired' }, 404);
      const session = JSON.parse(sessionRaw);
      return json(session);
    }

    // OAuth Callback endpoint (Browser redirected here from X)
    if (pathname === '/callback' && method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      const renderAuthUI = (titleZh: string, titleEn: string, subZh: string, subEn: string, isError: boolean = false) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Auth</title><style>body{font-family:'Inter',system-ui,-apple-system;background:#09090b;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;overflow:hidden;position:relative}.blob{position:absolute;border-radius:50%;filter:blur(80px);z-index:-1;opacity:0.5}.b1{width:300px;height:300px;background:radial-gradient(circle,#c1939b 0%,transparent 70%);top:-50px;left:-50px}.b2{width:400px;height:400px;background:radial-gradient(circle,#ebb5b2 0%,transparent 70%);bottom:-100px;right:-100px}.c{background:rgba(24,24,27,0.6);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:48px 32px;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);z-index:10;max-width:400px}h2{color:${isError ? '#ef4444' : '#c1939b'};margin-top:0;font-size:1.5rem}p{color:#a1a1aa;line-height:1.6}.close{font-size:13px;color:#71717a;margin-top:24px}.lang-en{display:none!important}.lang-zh{display:inline}body.en-mode .lang-zh{display:none!important}body.en-mode .lang-en{display:inline!important}</style></head><body><div class="blob b1"></div><div class="blob b2"></div><div class="c"><h2>${isError ? '❌' : '✅'} <span class="lang-zh">${titleZh}</span><span class="lang-en">${titleEn}</span></h2><p><span class="lang-zh">${subZh}</span><span class="lang-en">${subEn}</span></p><p class="close"><span class="lang-zh">这个页面可以安全退出了</span><span class="lang-en">You can safely close this page now.</span></p></div><script>if(localStorage.getItem('agentSettingsLang')==='en') document.body.classList.add('en-mode');</script></body></html>`;

      if (!state) return new Response(renderAuthUI('参数错误', 'Parameter Error', '缺少 state 参数。', 'Missing state parameter.', true), { status: 400, headers: {'Content-Type':'text/html; charset=utf-8'} });
      const sessionId = await env.AGENT_STATE.get('oauth_state:' + state);
      if (!sessionId) return new Response(renderAuthUI('授权过期', 'Auth Expired', 'Session 已失效，请回向导页重试。', 'Session expired, please retry from wizard.', true), { status: 400, headers: {'Content-Type':'text/html; charset=utf-8'} });
      
      const sessionRaw = await env.AGENT_STATE.get('oauth:' + sessionId);
      if (!sessionRaw) return new Response(renderAuthUI('授权过期', 'Auth Expired', 'Session 已失效，请回向导页重试。', 'Session expired, please retry from wizard.', true), { status: 400, headers: {'Content-Type':'text/html; charset=utf-8'} });
      const session = JSON.parse(sessionRaw);

      if (error) {
        session.status = 'error'; session.error = error;
        await env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(session), { expirationTtl: 600 });
        return new Response(renderAuthUI('授权被拒', 'Auth Denied', '你已拒绝授权，请关闭此页。', 'You have denied authorization, you can close this page.', true), { headers: {'Content-Type':'text/html; charset=utf-8'} });
      }

      const creds = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
      const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
        body: new URLSearchParams({
          code: code || '', grant_type: 'authorization_code', redirect_uri: session.redirectUri || url.origin + '/callback',
          code_verifier: session.codeVerifier, client_id: env.X_CLIENT_ID,
        }).toString(),
      });
      const data = await tokenRes.json() as any;
      if (!tokenRes.ok || !data.access_token) {
        session.status = 'error'; session.error = JSON.stringify(data);
        await env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(session), { expirationTtl: 600 });
        return new Response(renderAuthUI('获取令牌失败', 'Token Error', '与 X API 交换凭据失败，请重试。', 'Failed to exchange token with X API.', true), { status: 500, headers: {'Content-Type':'text/html; charset=utf-8'} });
      }

      session.status = 'done';
      session.accessToken = data.access_token;
      session.refreshToken = data.refresh_token;

      // If this is a reauth for an existing agent, persist new tokens to DB immediately
      if (session.agentId && data.refresh_token) {
        await env.DB.prepare(
          'UPDATE agents SET refresh_token=?, access_token=null, token_expires_at=0 WHERE id=?'
        ).bind(data.refresh_token, session.agentId).run();
        console.log(`[oauth] Reauth tokens updated in DB for agent ${session.agentId}`);
      }

      await env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(session), { expirationTtl: 600 });

      const successSub = session.agentId
        ? '授权已更新，新的 Refresh Token 现已生效。请关闭此页。'
        : '你的 X 账号已成功关联。请回到原部署向导页。';
      const successSubEn = session.agentId
        ? 'Authorization updated. New Refresh Token is now active. You can close this page.'
        : 'Your X account is successfully linked. Please return to the wizard.';
      return new Response(renderAuthUI('授权成功', 'Auth Successful', successSub, successSubEn), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // ── Reauth for existing agent ─────────────────────────────────────────────
    if (pathname === '/api/agent/reauth-start' && method === 'POST') {
      try {
        let reqBody: any = {};
        try { reqBody = await request.clone().json(); } catch(e) {}
        const reauthAgentId = url.searchParams.get('id') || reqBody.agentId;
        if (!reauthAgentId) return json({ error: 'Missing agentId' }, 400);

        const { results } = await env.DB.prepare('SELECT id FROM agents WHERE id = ?').bind(reauthAgentId).all();
        if (!results || results.length === 0) return json({ error: 'Agent not found' }, 404);

        const sessionId = crypto.randomUUID();
        const codeVerifier = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        const encoder = new TextEncoder();
        const cvData = encoder.encode(codeVerifier);
        const hashBuffer = await crypto.subtle.digest('SHA-256', cvData);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const codeChallenge = btoa(String.fromCharCode.apply(null, hashArray)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const state = crypto.randomUUID().replace(/-/g, '');

        const reqOrigin = env.LOCAL_ORIGIN || reqBody.currentOrigin || url.origin;
        const redirectUri = reqOrigin + '/callback';

        const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', env.X_CLIENT_ID);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access');
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');

        const sessionData = { state, codeVerifier, redirectUri, agentId: reauthAgentId, status: 'pending' };
        await env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(sessionData), { expirationTtl: 600 });
        await env.AGENT_STATE.put('oauth_state:' + state, sessionId, { expirationTtl: 600 });

        return json({ sessionId, authUrl: authUrl.toString() });
      } catch (err) { return json({ error: String(err) }, 500); }
    }

    if (pathname === '/api/oauth/refresh' && method === 'POST') {
      try {
        const reqJson = await request.json() as any;
        const refreshToken = reqJson.refreshToken;
        const creds = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
        const resTok = await fetch('https://api.twitter.com/2/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken || '', client_id: env.X_CLIENT_ID }).toString(),
        });
        const data = await resTok.json() as { access_token?: string; error?: string };
        if (!resTok.ok || !data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
        return json({ accessToken: data.access_token });
      } catch (err) { return json({ error: String(err) }, 400); }
    }

    if (pathname === '/api/me' && method === 'POST') {
      try {
        const reqJson = await request.json() as any;
        const res = await fetch('https://api.twitter.com/2/users/me', {
          headers: { Authorization: `Bearer ${reqJson.accessToken}` }
        });
        const data = await res.json() as any;
        if (!res.ok) throw new Error(data.detail || 'Failed to fetch user');
        return json(data.data);
      } catch (err) { return json({ error: String(err) }, 400); }
    }

    if (pathname === '/api/distill' && method === 'POST') {
      try {
        const reqJson = await request.json() as any;
        const { sourceAccounts, accessToken, promptLang } = reqJson;
        const geminiModel = env.GEMINI_MODEL || 'gemini-2.5-pro-preview-03-25';
        const gatewayConfig = { accountId: env.CF_ACCOUNT_ID, gateway: env.CF_GATEWAY_NAME, apiKey: env.CF_AIG_TOKEN };
        
        const tweetsByAccount = await fetchSourceTweets(sourceAccounts, accessToken);
        const accountCount = Object.keys(tweetsByAccount).length;
        if (accountCount === 0) return json({ error: 'No tweets fetched. Check accounts/token.' }, 400);
        
        const skill = await distillSkillFromTweets(tweetsByAccount, geminiModel, promptLang || 'zh', gatewayConfig);
        const fetched: Record<string, number> = {};
        for (const [k, v] of Object.entries(tweetsByAccount)) fetched[k] = v.length;
        return json({ skill, fetched });
      } catch (err) { return json({ error: String(err) }, 500); }
    }

    if (pathname === '/api/tune/sample' && method === 'POST') {
      try {
        const reqJson = await request.json() as any;
        const { skill } = reqJson;
        const geminiModel = env.GEMINI_MODEL || 'gemini-2.5-pro-preview-03-25';
        const gatewayConfig = { accountId: env.CF_ACCOUNT_ID, gateway: env.CF_GATEWAY_NAME, apiKey: env.CF_AIG_TOKEN };
        return json(await genSample(skill, geminiModel, gatewayConfig));
      } catch (err) { return json({ error: String(err) }, 500); }
    }

    if (pathname === '/api/tune/refine' && method === 'POST') {
      try {
        const reqJson = await request.json() as any;
        const { skill, feedback } = reqJson;
        const geminiModel = env.GEMINI_MODEL || 'gemini-2.5-pro-preview-03-25';
        const gatewayConfig = { accountId: env.CF_ACCOUNT_ID, gateway: env.CF_GATEWAY_NAME, apiKey: env.CF_AIG_TOKEN };
        return json({ skill: await refineSkill(skill, feedback, geminiModel, gatewayConfig) });
      } catch (err) { return json({ error: String(err) }, 500); }
    }

    if (pathname === '/api/models' && method === 'GET') {
      try {
        const models = await listGeminiModels();
        const filtered = models.filter(m => m.includes('gemini'));
        resSortModelsList(filtered);
        return json({ models: filtered });
      } catch (err) { return json({ error: String(err) }, 400); }
    }

    if (pathname === '/api/agent/create' && method === 'POST') {
      try {
        const reqJson = await request.json() as any;
        const config = reqJson.config;
        const skill = reqJson.skill;
        const refreshToken = reqJson.refreshToken;
        const geminiApiKey = env.GEMINI_API_KEY || reqJson.geminiApiKey || '';
        const dashboardSecret = reqJson.dashboardSecret || '';

        const vipList = config.vipList ?? [];
        const memWhitelist = config.memoryWhitelist ?? [];
        const handle = (config.agentHandle ?? '').trim().toLowerCase();

        // ── Upsert: if agent with same handle already exists, overwrite it ──
        let agentId = '';
        let isUpdate = false;

        if (handle) {
          const existing = await env.DB.prepare(
            'SELECT id FROM agents WHERE LOWER(agent_handle) = ? LIMIT 1'
          ).bind(handle).first<{ id: string }>();

          if (existing) {
            agentId = existing.id;
            isUpdate = true;
            await env.DB.prepare(`
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
              config.agentName ?? '',
              config.agentHandle ?? '',
              dashboardSecret,              // NULLIF turns '' → NULL → COALESCE keeps existing
              JSON.stringify(config.sourceAccounts ?? []),
              config.geminiModel ?? 'gemini-2.5-pro',
              geminiApiKey,
              refreshToken ?? '',
              skill ?? '',
              config.defaultReplyProbability ?? 0.2,
              config.defaultLikeProbability ?? 0.8,
              config.spontaneousCooldownDays ?? 3,
              config.enableNightlyEvolution ? 1 : 0,
              JSON.stringify(vipList),
              memWhitelist === 'all' ? 'all' : JSON.stringify(memWhitelist),
              agentId,
            ).run();
          }
        }

        if (!isUpdate) {
          agentId = crypto.randomUUID();
          await env.DB.prepare(`
            INSERT INTO agents (
              id, owner_id, agent_name, agent_handle, agent_secret, source_accounts, gemini_model, gemini_api_key, 
              refresh_token, access_token, token_expires_at, skill_text, reply_pct, like_pct, 
              cooldown_days, auto_evo, vip_list, mem_whitelist, created_at, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, null, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
          `).bind(
            agentId, 'public',
            config.agentName ?? '',
            config.agentHandle ?? '',
            dashboardSecret,
            JSON.stringify(config.sourceAccounts ?? []),
            config.geminiModel ?? 'gemini-2.5-pro',
            geminiApiKey,
            refreshToken ?? '',
            skill ?? '',
            config.defaultReplyProbability ?? 0.2,
            config.defaultLikeProbability ?? 0.8,
            config.spontaneousCooldownDays ?? 3,
            config.enableNightlyEvolution ? 1 : 0,
            JSON.stringify(vipList),
            memWhitelist === 'all' ? 'all' : JSON.stringify(memWhitelist),
            Date.now()
          ).run();
        }

        return json({ success: true, agentId, updated: isUpdate, redirect: `/dashboard?id=${agentId}` });
      } catch (err) { return json({ error: String(err) }, 500); }
    }

    // ── Find agent by Twitter handle (public, no auth required) ─────────────
    if (pathname === '/api/agent/find-by-handle' && method === 'GET') {
      const handle = (url.searchParams.get('handle') ?? '').replace(/^@/, '').trim().toLowerCase();
      if (!handle) return json({ error: 'handle required' }, 400);
      const { results } = await env.DB.prepare(
        'SELECT id, agent_name, agent_handle FROM agents WHERE LOWER(agent_handle)=? LIMIT 1'
      ).bind(handle).all();
      if (!results || results.length === 0) return json({ error: 'not_found' }, 404);
      const row = results[0] as any;
      return json({ agentId: row.id, name: row.agent_name, handle: row.agent_handle });
    }

    // ── Ko-Fi Webhook (POST /api/kofi-webhook) ────────────────────────────────
    // Ko-Fi sends form-encoded: data=<URL-encoded JSON>
    if (pathname === '/api/kofi-webhook' && method === 'POST') {
      try {
        const formText = await request.text();
        const params = new URLSearchParams(formText);
        const raw = params.get('data');
        if (!raw) return new Response('Missing data', { status: 400 });
        const data = JSON.parse(raw) as any;

        // Verify Ko-Fi token
        const expectedToken = env.KO_FI_VERIFICATION_TOKEN;
        if (expectedToken && data.verification_token !== expectedToken) {
          console.warn('[kofi] Invalid verification token');
          return new Response('Unauthorized', { status: 401 });
        }

        // Only process successful payments (not refunds/subscriptions cancellations)
        if (data.type !== 'Donation' && data.type !== 'Shop Order' && data.type !== 'Subscription') {
          return new Response('OK', { status: 200 });
        }

        // Generate license key: JLYF-XXXX-XXXX-XXXX
        const seg = () => Math.random().toString(36).slice(2, 6).toUpperCase();
        const licenseKey = `JLYF-${seg()}-${seg()}-${seg()}`;
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

        const licenseRecord = {
          key: licenseKey,
          email: data.email || '',
          kofi_name: data.from_name || '',
          amount: data.amount || '',
          expires_at: expiresAt,
          created_at: Date.now(),
          type: data.type,
        };

        // Store in KV: key → license record (TTL = 31 days)
        await env.AGENT_STATE.put(
          `license:${licenseKey}`,
          JSON.stringify(licenseRecord),
          { expirationTtl: 31 * 24 * 60 * 60 }
        );

        console.log(`[kofi] License generated for ${data.email}: ${licenseKey} (expires ${new Date(expiresAt).toISOString()})`);
        // Ko-Fi requires a 200 response otherwise it will retry
        return new Response('OK', { status: 200 });
      } catch (err) {
        console.error('[kofi] Webhook error:', err);
        return new Response('OK', { status: 200 }); // Always 200 to Ko-Fi
      }
    }

    // ── License Activation (POST /api/agent/activate-license) ─────────────────
    if (pathname === '/api/agent/activate-license' && method === 'POST') {
      try {
        const { agentId, key } = await request.json() as any;
        if (!agentId || !key) return json({ ok: false, error: 'Missing params' }, 400);

        const raw = await env.AGENT_STATE.get(`license:${key.trim().toUpperCase()}`);
        if (!raw) return json({ ok: false, error: '授权码无效或已过期 / Invalid or expired license key' }, 404);

        const license = JSON.parse(raw) as { expires_at: number; email: string };
        if (license.expires_at < Date.now()) {
          return json({ ok: false, error: '授权码已过期 / License key expired' }, 403);
        }

        // Write pro_expires_at to the agent record
        await env.DB.prepare('UPDATE agents SET pro_expires_at = ? WHERE id = ?')
          .bind(license.expires_at, agentId).run();

        console.log(`[license] Activated ${key} for agent ${agentId}, expires ${new Date(license.expires_at).toISOString()}`);
        return json({ ok: true, expires_at: license.expires_at });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    // ── Admin Dashboard UI ────────────────────────────────────────────────────
    if (pathname === '/dashboard' && method === 'GET') {
      const agentId = url.searchParams.get('id');
      if (!agentId) return new Response('Missing agent ID', { status: 400 });

      // fetch agent metadata
      const { results } = await env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(agentId).all();
      if (!results || results.length === 0) return new Response('Agent not found', { status: 404 });
      
      const agent = results[0] as unknown as AgentDbRecord;
      const vipList = typeof agent.vip_list === 'string' ? JSON.parse(agent.vip_list) : agent.vip_list;

      // Safely resolve mem_whitelist regardless of what DB returns (null, 'all', JSON string, array)
      const rawWl = (agent as any).mem_whitelist;
      const isMemWhitelistAll = rawWl === 'all';
      const memWhitelistArr: string[] = isMemWhitelistAll ? [] :
        Array.isArray(rawWl) ? rawWl :
        (() => { try { const p = JSON.parse(rawWl || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } })();

      const base = url.origin;

      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${agent.agent_name} · Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b; --card-bg: rgba(24,24,27,0.6); --card-border: rgba(255,255,255,0.08);
      --primary: #c1939b; --primary-hover: #ad7982; --primary-glow: rgba(193,147,155,0.3);
      --text: #fafafa; --text-muted: #a1a1aa; --input-bg: rgba(9,9,11,0.5);
      --input-border: rgba(255,255,255,0.1); --error: #ef4444; --success: #10b981;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden;position:relative;line-height:1.5}
    .blob{position:fixed;border-radius:50%;filter:blur(80px);z-index:-1;opacity:0.5;animation:float 20s infinite alternate}
    .blob-1{width:400px;height:400px;background:radial-gradient(circle,var(--primary) 0%,transparent 70%);top:-100px;left:-100px}
    .blob-2{width:600px;height:600px;background:radial-gradient(circle,#ebb5b2 0%,transparent 70%);bottom:-200px;right:-200px;animation-delay:-5s}
    @keyframes float{0%{transform:translateY(0) scale(1)}100%{transform:translateY(-50px) scale(1.1)}}
    .page-wrapper{max-width:960px;margin:0 auto;padding:40px 20px}
    header{text-align:center;margin-bottom:32px;position:relative}
    h1{font-size:2rem;font-weight:700;letter-spacing:-.02em}
    .text-gradient{background:linear-gradient(135deg,#dfa9b1,#ad7982);-webkit-background-clip:text;background-clip:text;color:transparent}
    .sub{color:var(--text-muted);font-size:.85rem;margin-top:4px}
    .badge{display:inline-block;padding:.1rem .5rem;background:rgba(193,147,155,.15);border:1px solid rgba(193,147,155,.3);border-radius:6px;font-size:.78rem;color:var(--primary);margin-left:.5rem}
    .header-actions{position:absolute;right:0;top:0;display:flex;gap:8px;align-items:center}
    /* Auth gate */
    #auth-gate{background:var(--card-bg);backdrop-filter:blur(12px);border:1px solid var(--card-border);border-radius:24px;padding:48px 32px;max-width:420px;margin:80px auto;text-align:center}
    #auth-gate h2{font-size:1.4rem;margin-bottom:8px}
    #auth-gate p{color:var(--text-muted);font-size:.9rem;margin-bottom:24px}
    /* Cards */
    .card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
    .card{background:var(--card-bg);backdrop-filter:blur(12px);border:1px solid var(--card-border);border-radius:16px;padding:20px;transition:border-color .2s}
    .card:hover{border-color:rgba(255,255,255,0.18)}
    .card h2{font-size:.9rem;font-weight:600;color:var(--primary);margin-bottom:6px}
    .card p{font-size:.82rem;color:var(--text-muted);margin-bottom:14px;line-height:1.55}
    .wide{grid-column:1/-1}
    /* Buttons */
    .btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border-radius:10px;font-weight:600;font-size:.85rem;cursor:pointer;transition:all .2s;border:none;font-family:inherit;white-space:nowrap;text-decoration:none}
    .btn-primary{background:var(--primary);color:#fff;box-shadow:0 4px 14px 0 var(--primary-glow)}
    .btn-primary:hover{background:var(--primary-hover);transform:translateY(-1px)}
    .btn-ghost{background:transparent;color:var(--text-muted);border:1px solid var(--input-border)}
    .btn-ghost:hover{background:rgba(255,255,255,0.05);color:var(--text)}
    .btn-danger{background:rgba(239,68,68,0.15);color:#fca5a5;border:1px solid rgba(239,68,68,0.25)}
    .btn + .btn{margin-left:8px}
    /* Form elements */
    input[type=text],input[type=number],input[type=password],textarea{width:100%;background:var(--input-bg);border:1px solid var(--input-border);color:var(--text);padding:10px 14px;border-radius:10px;font-size:.88rem;font-family:inherit;transition:all .2s;margin-top:6px}
    input[type=text]:focus,input[type=number]:focus,input[type=password]:focus,textarea:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-glow)}
    /* Number spinner: hide native arrows, accent right border */
    input[type=number]{-moz-appearance:textfield;appearance:textfield;padding-right:10px;border-right:3px solid rgba(193,147,155,0.35)}
    input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
    input[type=number]:focus{border-right-color:var(--primary)}
    textarea{min-height:300px;resize:vertical;font-family:'JetBrains Mono',monospace;font-size:.8rem}
    label{display:block;font-weight:500;font-size:.85rem;color:#e4e4e7;margin-top:14px}
    .cfg-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px}
    /* Output */
    /* Debug output panel — fixed floating at bottom */
    #output{position:fixed;bottom:0;left:50%;transform:translateX(-50%) translateY(100%);width:min(860px,96vw);max-height:52vh;background:rgba(5,5,10,.97);border:1px solid rgba(134,239,172,.2);border-bottom:none;border-radius:14px 14px 0 0;padding:0;font-family:'JetBrains Mono',monospace;font-size:.78rem;color:#86efac;line-height:1.6;z-index:9999;display:none;overflow:hidden;box-shadow:0 -8px 40px rgba(0,0,0,.6);transition:transform .3s cubic-bezier(.16,1,.3,1)}
    #output.visible{transform:translateX(-50%) translateY(0)}
    #output-header{display:flex;align-items:center;justify-content:space-between;padding:9px 16px;border-bottom:1px solid rgba(134,239,172,.1);background:rgba(134,239,172,.05);font-size:.72rem;color:rgba(134,239,172,.6)}
    #output-close{cursor:pointer;background:none;border:none;color:rgba(134,239,172,.5);font-size:1rem;padding:0 4px;line-height:1;transition:color .15s}
    #output-close:hover{color:#86efac}
    #output-body{padding:14px 16px;overflow-y:auto;max-height:calc(52vh - 40px);white-space:pre-wrap}
    /* Button spinner */
    @keyframes spin{to{transform:rotate(360deg)}}
    .btn-loading{position:relative;pointer-events:none;opacity:.75}
    .btn-loading::after{content:'';position:absolute;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;right:12px;top:50%;margin-top:-7px}
    /* Global scrollbar */
    ::-webkit-scrollbar{width:6px;height:6px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:rgba(193,147,155,0.25);border-radius:99px}
    ::-webkit-scrollbar-thumb:hover{background:rgba(193,147,155,0.5)}
    *{scrollbar-width:thin;scrollbar-color:rgba(193,147,155,0.25) transparent}
    /* VIP */
    .vip-chip{display:inline-block;padding:.1rem .45rem;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.2);border-radius:4px;color:#fbbf24;margin:.15rem;font-size:.75rem}
    /* Status */
    .status-tag{font-size:.75rem;margin-left:10px;vertical-align:middle}
    /* Lang */
    .lang-en{display:none!important}
    .lang-zh{display:inline}
    body.en-mode .lang-zh{display:none!important}
    body.en-mode .lang-en{display:inline!important}
    .section-title{font-size:.75rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);margin:28px 0 12px}
  </style>
</head>
<body>
<script>
  // Run synchronously before any paint to prevent auth-gate flash on reload
  (function() {
    var s = sessionStorage.getItem('dashSecret');
    if (s) {
      document.write('<style>#auth-gate{display:none!important}#dashboard{display:block!important}</style>');
    }
  })();
</script>
<div class="blob blob-1"></div>
<div class="blob blob-2"></div>

<!-- Auth Gate -->
<div id="auth-gate">
  <h2>🔐 <span class="lang-zh">进入控制台</span><span class="lang-en">Enter Dashboard</span></h2>
  <div style="margin-top: 16px;">
    <button class="btn btn-primary" onclick="window.open('/api/oauth/start', 'oauth', 'width=600,height=600')" style="width:100%;height:44px;background:#1da1f2;margin-bottom:12px">
      <span class="lang-zh">使用 X (Twitter) 登录</span><span class="lang-en">Log in with X (Twitter)</span>
    </button>
    <div style="text-align:center;font-size:0.8rem;color:#71717a;margin-bottom:12px">
      <span class="lang-zh">或使用密码登录</span><span class="lang-en">OR login with password</span>
    </div>
    <input type="password" id="secret-input" placeholder="Dashboard Secret" style="margin-bottom:14px">
    <button class="btn btn-ghost" onclick="doAuthSecret()" style="width:100%;height:44px">
      <span class="lang-zh">密码验证</span><span class="lang-en">Verify Password</span>
    </button>
  </div>
  <div id="auth-err" style="color:var(--error);font-size:.82rem;margin-top:10px;display:none">
    <span class="lang-zh">验证失败</span><span class="lang-en">Verification failed</span>
  </div>
</div>

<!-- Dashboard (hidden until authed) -->
<div id="dashboard" style="display:none">
<div class="page-wrapper">
  <header>
    <div class="header-actions">
      <button id="langToggle" class="btn btn-ghost" style="height:36px;padding:0 14px;font-size:.82rem">🌐 English</button>
      <a href="/" class="btn btn-ghost" style="height:36px;padding:0 14px;font-size:.82rem">← <span class="lang-zh">首页</span><span class="lang-en">Home</span></a>
    </div>
    <h1 id="dash-name"><span style="opacity:.4">...</span> <span class="text-gradient">Dashboard</span></h1>
    <div class="sub" id="dash-sub"><span style="opacity:.4">@... · </span><span class="lang-zh">Agent ID:</span><span class="lang-en">Agent ID:</span> <code style="font-size:.78rem;opacity:.7">${agentId}</code></div>
  </header>

  <div class="section-title"><span class="lang-zh">手动触发操作</span><span class="lang-en">Manual Actions</span></div>
  <div class="card-grid">
    <div class="card">
      <h2>📬 <span class="lang-zh">回复提及</span><span class="lang-en">Reply Mentions</span></h2>
      <p><span class="lang-zh">立即扫描新的 @mention 并生成回复</span><span class="lang-en">Scan new @mentions and generate replies immediately</span></p>
      <p style="font-size:.8rem;color:var(--text-muted);margin-top:4px">
        🕒 <span class="lang-zh">自动扫描：每分钟触发，单次内<b>每 15 秒</b>扫描一轮，共 4 轮</span><span class="lang-en">Auto-scans: triggered every minute, 4 sweeps per trigger at <b>15s</b> intervals</span>
      </p>
      <a class="btn btn-primary" href="#" onclick="run(event,'/api/agent/trigger?id=${agentId}');return false"><span class="lang-zh">立即触发</span><span class="lang-en">Trigger Now</span></a>
    </div>
    <div class="card">
      <h2>👀 <span class="lang-zh">刷时间线</span><span class="lang-en">Browse Timeline</span></h2>
      <p><span class="lang-zh">扫描粉丝/VIP 列表，随机点赞或回复 2 条推文</span><span class="lang-en">Scan fans/VIP list, randomly like or reply to 2 tweets</span></p>
      <p style="font-size:.8rem;color:var(--text-muted);margin-top:4px">
        🕒 <span class="lang-zh">自动执行：<b>每小时整点</b>一次（UTC 00:00、01:00 … 23:00）</span><span class="lang-en">Auto-runs: once per hour on the hour (UTC 00:00, 01:00 … 23:00)</span>
      </p>
      <p style="font-size:.75rem;color:#a78bfa;margin-top:6px">⭐ <span class="lang-zh">手动触发为 Pro 功能</span><span class="lang-en">Manual trigger is a Pro feature</span></p>
    </div>
    <div class="card">
      <h2>💬 <span class="lang-zh">自发推文</span><span class="lang-en">Spontaneous Tweet</span></h2>
      <p><span class="lang-zh">随机生成并发布一条自发推文</span><span class="lang-en">Generate and post a spontaneous tweet</span></p>
      <p style="font-size:.8rem;color:var(--text-muted);margin-top:4px">
        🕒 <span class="lang-zh">自动触发：每日 <b>UTC 12:30</b>（北京时间 20:30）检查一次，冷却期内跳过。冷却固定 <b>3 天</b></span><span class="lang-en">Auto-triggers daily at <b>UTC 12:30</b> (20:30 CST); skips if within <b>3-day</b> cooldown</span>
      </p>
      <p style="font-size:.75rem;color:#a78bfa;margin-top:6px">⭐ <span class="lang-zh">无视冷却发推为 Pro 功能</span><span class="lang-en">Bypassing cooldown is a Pro feature</span></p>
    </div>
    <div class="card">
      <h2>🧠 <span class="lang-zh">互动记忆</span><span class="lang-en">Interaction Memory</span></h2>
      <p><span class="lang-zh">查看白名单用户塑造 Agent 的历史互动记录</span><span class="lang-en">View historical interaction records shaping the Agent</span></p>
      <p style="font-size:.8rem;color:var(--text-muted);margin-top:4px">
        🕒 <span class="lang-zh">自动刷取：每 <b>6 小时</b>一次（UTC 00:00 / 06:00 / 12:00 / 18:00，即北京时间 08 / 14 / 20 / 02 时）</span><span class="lang-en">Auto-refreshes every <b>6 hours</b> (UTC 00:00 / 06:00 / 12:00 / 18:00)</span>
      </p>
      <a class="btn btn-ghost" target="_blank" href="${base}/api/agent/memory?id=${agentId}"><span class="lang-zh">查看记忆</span><span class="lang-en">View Memory</span></a>
      <p style="font-size:.75rem;color:#a78bfa;margin-top:8px">⭐ <span class="lang-zh">立即强制拉取为 Pro 功能</span><span class="lang-en">Instant force-refresh is a Pro feature</span></p>
    </div>
    <div class="card">
      <h2 style="color:#c084fc">🧬 <span class="lang-zh">人格演化</span><span class="lang-en">Persona Evolution</span></h2>
      <p><span class="lang-zh">吸收现有记忆重塑底层人格（执行后清空记忆库）。</span><span class="lang-en">Absorb memories to reshape persona (clears memory after).</span></p>
      <p style="font-size:.8rem;color:var(--text-muted);margin-top:4px">
        🕒 <span class="lang-zh">自动执行：每日 <b>UTC 03:00</b>（北京时间 11:00），需开启「自动演化」</span><span class="lang-en">Auto-runs: daily at <b>UTC 03:00</b> (11:00 CST), requires "Auto Evolution" enabled</span>
      </p>
      <p style="font-size:.75rem;color:#a78bfa;margin-top:6px">⭐ <span class="lang-zh">立即强制重塑为 Pro 功能</span><span class="lang-en">Instant force-evolve is a Pro feature</span></p>
    </div>
    <div class="card">
      <h2>📊 <span class="lang-zh">Agent 状态</span><span class="lang-en">Agent Status</span></h2>
      <p><span class="lang-zh">查看当前状态与配置信息</span><span class="lang-en">View current status and configuration</span></p>
      <a class="btn btn-ghost" href="#" onclick="run(event,'/api/agent/status?id=${agentId}');return false"><span class="lang-zh">查看</span><span class="lang-en">View</span></a>
      <a class="btn btn-ghost" target="_blank" href="${base}/api/agent/activity?id=${agentId}"><span class="lang-zh">活动日志</span><span class="lang-en">Activity Log</span></a>
    </div>
  </div>

  <div class="section-title" style="background:linear-gradient(90deg,#7c3aed22,transparent);border-left:3px solid #7c3aed;padding-left:12px">
    ⭐ <span class="lang-zh">Pro 功能</span><span class="lang-en">Pro Features</span>
  </div>
  <div class="card wide" style="border-color:rgba(139,92,246,0.35);margin-bottom:20px;padding-bottom:20px">
    <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:16px">
      <div style="flex:1;min-width:220px">
        <h2 style="color:#a78bfa;margin-bottom:6px">🔑 <span class="lang-zh">授权码</span><span class="lang-en">License Key</span></h2>
        <p style="font-size:.82rem;color:var(--text-muted);margin-bottom:10px">
          <span class="lang-zh">输入有效的授权码以解锁 Pro 功能（支持按月订阅）。购买后会将授权码发送到你的邮箱。</span>
          <span class="lang-en">Enter a valid license key to unlock Pro features (monthly subscription). The key will be emailed after purchase.</span>
        </p>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="pro-key-input" type="text" placeholder="JLYF-XXXX-XXXX-XXXX" style="margin:0;flex:1;font-family:monospace;letter-spacing:.05em" />
          <button class="btn btn-ghost" style="border-color:rgba(139,92,246,0.5);color:#a78bfa;white-space:nowrap" onclick="activateProKey('${agentId}')">
            <span class="lang-zh">激活</span><span class="lang-en">Activate</span>
          </button>
        </div>
        <div id="pro-key-status" style="font-size:.78rem;margin-top:6px">
          ${(agent as any).pro_expires_at && (agent as any).pro_expires_at > Date.now()
            ? `<span style="color:#86efac">✅ Pro 已激活，有效至 <b>${new Date((agent as any).pro_expires_at).toLocaleDateString('zh-CN')}</b></span>`
            : `<span style="color:var(--text-muted)">🔒 <span class="lang-zh">未激活 &middot; <a href="https://ko-fi.com/HomeCollider" target="_blank" style="color:#a78bfa">Ko-Fi 购买授权</a></span><span class="lang-en">Not activated &middot; <a href="https://ko-fi.com/HomeCollider" target="_blank" style="color:#a78bfa">Buy on Ko-Fi</a></span></span>`
          }
        </div>
      </div>
    </div>
    <hr style="border:none;border-top:1px solid rgba(139,92,246,0.12);margin:0 0 14px">
    <p style="font-size:.78rem;color:var(--text-muted);margin-bottom:12px">
      <span class="lang-zh">以下功能需要有效授权码才可使用</span>
      <span class="lang-en">The following actions require an active Pro license</span>
    </p>
    <div class="card-grid" style="gap:10px">
      <div class="card" style="border-color:rgba(139,92,246,0.25)">
        <h2 style="font-size:.95rem">👀 <span class="lang-zh">刷时间线</span><span class="lang-en">Browse Timeline</span></h2>
        <p style="font-size:.78rem"><span class="lang-zh">立即扫描粉丝/VIP 列表，随机点赞或回复</span><span class="lang-en">Scan fans/VIP, randomly like or reply now</span></p>
        <a class="btn btn-ghost" style="border-color:rgba(139,92,246,0.4);color:#a78bfa" href="#" onclick="runPro(event,'/api/agent/trigger-timeline?id=${agentId}');return false"><span class="lang-zh">立即执行</span><span class="lang-en">Run Now</span></a>
      </div>
      <div class="card" style="border-color:rgba(139,92,246,0.25)">
        <h2 style="font-size:.95rem">💬 <span class="lang-zh">无视冷却发推</span><span class="lang-en">Force Tweet</span></h2>
        <p style="font-size:.78rem"><span class="lang-zh">跳过 3 天冷却限制，立即发布一条自发推文</span><span class="lang-en">Skip the 3-day cooldown and post a spontaneous tweet now</span></p>
        <a class="btn btn-ghost" style="border-color:rgba(139,92,246,0.4);color:#a78bfa" href="#" onclick="runPro(event,'/api/agent/spontaneous?id=${agentId}&force=true');return false"><span class="lang-zh">立即发布</span><span class="lang-en">Post Now</span></a>
      </div>
      <div class="card" style="border-color:rgba(139,92,246,0.25)">
        <h2 style="font-size:.95rem">🧠 <span class="lang-zh">立即拉取记忆</span><span class="lang-en">Force Refresh Memory</span></h2>
        <p style="font-size:.78rem"><span class="lang-zh">跳过每 6 小时周期，立即拉取最新互动记忆</span><span class="lang-en">Skip the 6h schedule and refresh memories now</span></p>
        <a class="btn btn-ghost" style="border-color:rgba(139,92,246,0.4);color:#a78bfa" href="#" onclick="runPro(event,'/api/agent/refresh-memory?id=${agentId}');return false"><span class="lang-zh">立即拉取</span><span class="lang-en">Refresh Now</span></a>
      </div>
      <div class="card" style="border-color:rgba(139,92,246,0.25)">
        <h2 style="font-size:.95rem">🧬 <span class="lang-zh">立即强制重塑</span><span class="lang-en">Force Evolve</span></h2>
        <p style="font-size:.78rem"><span class="lang-zh">跳过每日 UTC 03:00 周期，立即吸收记忆重塑人格</span><span class="lang-en">Skip the daily UTC 03:00 schedule and evolve persona now</span></p>
        <a class="btn btn-ghost" style="border-color:rgba(139,92,246,0.4);color:#a78bfa" href="#" onclick="runPro(event,'/api/agent/evolve?id=${agentId}');return false"><span class="lang-zh">立即重塑</span><span class="lang-en">Evolve Now</span></a>
      </div>
    </div>
  </div>

  <div class="section-title"><span class="lang-zh">配置调节</span><span class="lang-en">Configuration</span></div>
  <div class="card-grid">
    <div class="card wide" style="border-color:rgba(37,99,235,0.4)">
      <h2 style="color:#60a5fa">⚙️ <span class="lang-zh">概率调节</span><span class="lang-en">Probability Settings</span></h2>
      <p><span class="lang-zh">调整回复概率与点赞概率</span><span class="lang-en">Adjust reply and like probability</span></p>
      <div class="cfg-grid" style="grid-template-columns:1fr 1fr">
        <label><span class="lang-zh">回复概率 (0~1)</span><span class="lang-en">Reply Probability (0~1)</span>
          <input id="cfg-reply" type="number" step="0.05" min="0" max="1" value="${agent.reply_pct}">
        </label>
        <label><span class="lang-zh">点赞概率 (0~1)</span><span class="lang-en">Like Probability (0~1)</span>
          <input id="cfg-like" type="number" step="0.05" min="0" max="1" value="${agent.like_pct}">
        </label>
      </div>
      <button class="btn btn-primary" onclick="saveConfig('${agentId}')">💾 <span class="lang-zh">保存配置</span><span class="lang-en">Save Config</span></button>
      <span id="cfg-status" class="status-tag"></span>
    </div>

    <div class="card wide" style="border-color:rgba(20,184,166,0.4)">
      <h2 style="color:#2dd4bf">📝 <span class="lang-zh">记忆白名单</span><span class="lang-en">Memory Whitelist</span></h2>
      <p><span class="lang-zh">设置搜集哪些用户互动记忆的账号。选择「所有人」或填入指定 @handle（逗号分隔）。</span><span class="lang-en">Set which users' interactions are absorbed into memory. Choose everyone, or list specific handles (comma-separated).</span></p>
      <div style="display:flex;gap:16px;margin:12px 0">
        <label style="margin-top:0;display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="wl-mode" id="wl-all" value="all" ${isMemWhitelistAll ? 'checked' : ''} style="width:auto;height:auto;margin-top:0">
          <span class="lang-zh">🌍 所有人</span><span class="lang-en">🌍 Everyone</span>
        </label>
        <label style="margin-top:0;display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="wl-mode" id="wl-specific" value="specific" ${!isMemWhitelistAll ? 'checked' : ''} style="width:auto;height:auto;margin-top:0">
          <span class="lang-zh">📌 指定账号</span><span class="lang-en">📌 Specific accounts</span>
        </label>
      </div>
      <div id="wl-accounts-row" style="${!isMemWhitelistAll ? '' : 'display:none'}">
        <input id="wl-accounts" type="text" placeholder="handle1, handle2, handle3" value="${memWhitelistArr.join(', ')}" style="margin-top:0">
      </div>
      <button class="btn btn-primary" style="margin-top:12px" onclick="saveWhitelist('${agentId}')">💾 <span class="lang-zh">保存</span><span class="lang-en">Save</span></button>
      <span id="wl-status" class="status-tag"></span>
    </div>

    <div class="card wide" style="border-color:rgba(251,191,36,0.4)">
      <h2 style="color:#fbbf24">⭐ <span class="lang-zh">VIP 用户规则</span><span class="lang-en">VIP User Rules</span></h2>
      <p><span class="lang-zh">为指定用户设置单独的回复/点赞概率和备注 persona。这些用户会被优先置入时间线队列。</span><span class="lang-en">Set per-user reply/like probabilities and persona note. These users are prioritized in timeline engagement.</span></p>
      <table id="vip-table" style="width:100%;border-collapse:collapse;font-size:.82rem;margin:12px 0">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--input-border)">
            <th style="text-align:left;padding:6px 8px">@handle</th>
            <th style="text-align:center;padding:6px 4px"><span class="lang-zh">回复率</span><span class="lang-en">Reply%</span></th>
            <th style="text-align:center;padding:6px 4px"><span class="lang-zh">点赞率</span><span class="lang-en">Like%</span></th>
            <th style="text-align:left;padding:6px 4px">Persona</th>
            <th style="padding:6px 4px"></th>
          </tr>
        </thead>
        <tbody id="vip-tbody">
          ${(vipList as any[]).map((v: any, i: number) => `
          <tr data-idx="${i}" style="border-bottom:1px solid rgba(255,255,255,0.04)">
            <td style="padding:6px 8px">@${v.username}</td>
            <td style="padding:6px 4px;text-align:center">${((v.replyProbability ?? 0) * 100).toFixed(0)}%</td>
            <td style="padding:6px 4px;text-align:center">${((v.likeProbability ?? 0) * 100).toFixed(0)}%</td>
            <td style="padding:6px 4px;color:var(--text-muted)">${v.persona ?? ''}</td>
            <td style="padding:6px 4px"><button class="btn btn-ghost" style="height:28px;padding:0 10px;font-size:.75rem;border-color:rgba(239,68,68,0.3);color:#f87171" onclick="deleteVip('${agentId}',${i})">✕</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 2fr auto;gap:8px;align-items:end;margin-top:8px" id="vip-add-row">
        <label style="margin-top:0"><span class="lang-zh">用户名（不含 @）</span><span class="lang-en">Username (no @)</span>
          <input id="vip-new-handle" type="text" placeholder="handle" style="margin-top:4px">
        </label>
        <label style="margin-top:0"><span class="lang-zh">回复率</span><span class="lang-en">Reply%</span>
          <input id="vip-new-reply" type="number" min="0" max="1" step="0.05" value="0.8" style="margin-top:4px">
        </label>
        <label style="margin-top:0"><span class="lang-zh">点赞率</span><span class="lang-en">Like%</span>
          <input id="vip-new-like" type="number" min="0" max="1" step="0.05" value="1" style="margin-top:4px">
        </label>
        <label style="margin-top:0">Persona <span style="opacity:.5;font-size:.75rem">(可空)</span>
          <input id="vip-new-persona" type="text" placeholder="e.g. 主人" style="margin-top:4px">
        </label>
        <button class="btn btn-primary" style="margin-top:0;height:44px" onclick="addVip('${agentId}')">✚ <span class="lang-zh">添加</span><span class="lang-en">Add</span></button>
      </div>
      <span id="vip-status" class="status-tag"></span>
    </div>

    <div class="card wide" style="border-color:rgba(139,92,246,0.4)">
      <h2 style="color:#c084fc">✍️ <span class="lang-zh">微调人格 (System Prompt)</span><span class="lang-en">Fine-tune Persona (System Prompt)</span></h2>
      <p><span class="lang-zh">直接编辑人格配置文本，保存后下一次触发即生效</span><span class="lang-en">Edit persona text directly; takes effect on next trigger</span></p>
      <textarea id="skill-text">${(agent.skill_text ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
      <button class="btn btn-primary" onclick="saveSkill('${agentId}')">💾 <span class="lang-zh">保存人格</span><span class="lang-en">Save Persona</span></button>
      <span id="skill-status" class="status-tag"></span>
    </div>

    <div class="card wide" style="border-color:rgba(239,68,68,0.4)">
      <h2 style="color:#f87171">🔑 <span class="lang-zh">控制台密码</span><span class="lang-en">Dashboard Secret</span></h2>
      <p><span class="lang-zh">设置或更新控制台访问密码</span><span class="lang-en">Set or update dashboard access password</span></p>
      <div style="display:flex;gap:12px;margin-bottom:14px">
        <input id="dash-secret-update" type="password" placeholder="New Secret" style="max-width:300px;margin-top:0">
        <button class="btn btn-danger" onclick="updateDashSecret('${agentId}')">💾 <span class="lang-zh">保存密码</span><span class="lang-en">Save Password</span></button>
      </div>
      <span id="secret-status" class="status-tag"></span>
    </div>

    <div class="card wide" style="border-color:rgba(234,179,8,0.4)">
      <h2 style="color:#fbbf24">🔄 <span class="lang-zh">重新授权 X 账号</span><span class="lang-en">Re-authorize X Account</span></h2>
      <p><span class="lang-zh">当 Refresh Token 失效或被撤销时，重新走一遍 OAuth 授权流程以恢复 Agent 正常运行。</span><span class="lang-en">Re-run the OAuth flow to recover the Agent when its Refresh Token has expired or been revoked.</span></p>
      <button class="btn btn-ghost" id="reauthBtn" onclick="doReauth('${agentId}')" style="border-color:rgba(234,179,8,0.4);color:#fbbf24">
        🔗 <span class="lang-zh">开始重新授权</span><span class="lang-en">Start Re-authorization</span>
      </button>
      <div id="reauth-status" class="status-tag" style="margin-left:12px"></div>
    </div>
  </div>

  <div id="output">
    <div id="output-header">
      <span>🖥️ <span class="lang-zh">操作结果</span><span class="lang-en">Output</span></span>
      <button id="output-close" onclick="closeOutput()">✕</button>
    </div>
    <div id="output-body"></div>
  </div>
</div>
</div>

<script>
  // ── Auth ──────────────────────────────────────────────────────────────────
  (function() {
    var saved = sessionStorage.getItem('dashSecret');
    if (saved) { doAuthSecret(saved); }
  })();

  // OAuth Listener
  window.addEventListener('message', async (e) => {
    if (e.data && e.data.type === 'oauth_success') {
      verifyOAuth(e.data.accessToken);
    }
  });

  async function verifyOAuth(accessToken) {
    document.getElementById('auth-err').style.display = 'none';
    var r = await fetch('/api/agent/verify-owner', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ agentId: '${agentId}', accessToken })
    });
    var d = await r.json();
    if (d.ok) {
      document.getElementById('auth-gate').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      fetchTwitterIdentity();
    } else {
      var err = document.getElementById('auth-err');
      err.style.display = 'block';
      err.textContent = 'Auth failed: ' + (d.error || 'Handle mismatch');
    }
  }

  function doAuthSecret(prefillSecret) {
    document.getElementById('auth-err').style.display = 'none';
    var s = prefillSecret || document.getElementById('secret-input').value.trim();
    if (!s) return;
    verifySecretCall(s, !prefillSecret);
  }

  async function verifySecretCall(secret, fromInput) {
    var r = await fetch('/api/agent/verify-secret', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ agentId: '${agentId}', secret })
    });
    var d = await r.json();
    if (d.ok) {
      sessionStorage.setItem('dashSecret', secret);
      document.getElementById('auth-gate').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      fetchTwitterIdentity();
    } else if (fromInput) {
      var err = document.getElementById('auth-err');
      err.style.display = 'block';
      err.textContent = document.body.classList.contains('en-mode') ? 'Incorrect password' : '密码错误';
    }
  }

  document.getElementById('secret-input')?.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doAuthSecret();
  });

  // ── Whitelist ─────────────────────────────────────────────────────
  document.querySelectorAll('input[name="wl-mode"]').forEach(function(r) {
    r.addEventListener('change', function() {
      document.getElementById('wl-accounts-row').style.display =
        document.getElementById('wl-specific').checked ? '' : 'none';
    });
  });

  async function saveWhitelist(id) {
    var isAll = document.getElementById('wl-all').checked;
    var raw = document.getElementById('wl-accounts').value;
    var handles = raw.split(',').map(function(s){return s.trim().replace(/^@/,'');}).filter(Boolean);
    var value = isAll ? 'all' : handles;
    var st = document.getElementById('wl-status');
    var isEn = document.body.classList.contains('en-mode');
    if (!isAll && handles.length === 0) { st.textContent = isEn ? '⚠️ Enter at least one handle' : '⚠️ 请至少输入一个账号'; st.style.color='#fbbf24'; return; }
    st.textContent = isEn ? '⏳ Saving...' : '⏳ 保存中...'; st.style.color='#94a3b8';
    try {
      var r = await fetch('/api/agent/update-whitelist?id=' + id, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ whitelist: value })
      });
      var d = await r.json();
      st.textContent = d.ok ? (isEn ? '✅ Saved' : '✅ 已保存') : '❌ ' + d.error;
      st.style.color = d.ok ? '#86efac' : '#f87171';
    } catch(e) { st.textContent = '❌ ' + e.message; st.style.color='#f87171'; }
  }

  // ── VIP ─────────────────────────────────────────────────────────────
  var _vipList = ${JSON.stringify(vipList)};

  function renderVipTable() {
    var tbody = document.getElementById('vip-tbody');
    tbody.innerHTML = '';
    _vipList.forEach(function(v, i) {
      var tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid rgba(255,255,255,0.04)';
      tr.innerHTML =
        '<td style="padding:6px 8px">@' + v.username + '</td>' +
        '<td style="padding:6px 4px;text-align:center">' + Math.round((v.replyProbability||0)*100) + '%</td>' +
        '<td style="padding:6px 4px;text-align:center">' + Math.round((v.likeProbability||0)*100) + '%</td>' +
        '<td style="padding:6px 4px;color:var(--text-muted)">' + (v.persona||'') + '</td>' +
        '<td style="padding:6px 4px"><button data-idx="' + i + '" class="vip-del-btn btn btn-ghost" style="height:28px;padding:0 10px;font-size:.75rem;border-color:rgba(239,68,68,0.3);color:#f87171">\u2715</button></td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.vip-del-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        deleteVip('${agentId}', parseInt(btn.getAttribute('data-idx')));
      });
    });
  }

  async function _saveVip(id) {
    var st = document.getElementById('vip-status');
    var isEn = document.body.classList.contains('en-mode');
    try {
      var r = await fetch('/api/agent/update-vip?id=' + id, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ vip_list: _vipList })
      });
      var d = await r.json();
      st.textContent = d.ok ? (isEn ? '✅ Saved' : '✅ 已保存') : '❌ ' + d.error;
      st.style.color = d.ok ? '#86efac' : '#f87171';
    } catch(e) { st.textContent = '❌ ' + e.message; st.style.color='#f87171'; }
  }

  async function addVip(id) {
    var handle = document.getElementById('vip-new-handle').value.trim().replace(/^@/, '');
    var reply = parseFloat(document.getElementById('vip-new-reply').value);
    var like = parseFloat(document.getElementById('vip-new-like').value);
    var persona = document.getElementById('vip-new-persona').value.trim();
    var st = document.getElementById('vip-status');
    var isEn = document.body.classList.contains('en-mode');
    if (!handle) { st.textContent = isEn ? '⚠️ Username required' : '⚠️ 请输入用户名'; st.style.color='#fbbf24'; return; }
    if (_vipList.some(function(v){return v.username.toLowerCase()===handle.toLowerCase();})) {
      st.textContent = isEn ? '⚠️ Already in list' : '⚠️ 该用户已在列表中'; st.style.color='#fbbf24'; return;
    }
    _vipList.push({ username: handle, replyProbability: reply, likeProbability: like, persona: persona || undefined });
    renderVipTable();
    document.getElementById('vip-new-handle').value = '';
    document.getElementById('vip-new-persona').value = '';
    await _saveVip(id);
  }

  async function deleteVip(id, idx) {
    _vipList.splice(idx, 1);
    renderVipTable();
    await _saveVip(id);
  }

  // ── Update identity (name / handle) from Twitter ────────────────────
  async function fetchTwitterIdentity() {
    try {
      var r = await fetch('/api/agent/twitter-identity?id=${agentId}');
      var d = await r.json();
      if (d.name) {
        document.getElementById('dash-name').innerHTML =
          d.name + ' <span class="text-gradient">Dashboard</span>';
      }
      if (d.username) {
        document.getElementById('dash-sub').innerHTML =
          '<span class="lang-zh">Agent ID:</span><span class="lang-en">Agent ID:</span>' +
          ' <code style="font-size:.78rem;opacity:.7">${agentId}</code>';
      }
    } catch(e) { console.warn('[dashboard] identity fetch failed:', e); }
  }

  // ── Language toggle ───────────────────────────────────────────────────────
  (function() {
    var btn = document.getElementById('langToggle');
    var setLang = function(lang) {
      if (lang === 'en') {
        document.body.classList.add('en-mode');
        btn.textContent = '🌐 中文';
        localStorage.setItem('agentSettingsLang', 'en');
      } else {
        document.body.classList.remove('en-mode');
        btn.textContent = '🌐 English';
        localStorage.setItem('agentSettingsLang', 'zh');
      }
    };
    var saved = localStorage.getItem('agentSettingsLang');
    if (saved === 'en') setLang('en');
    btn.addEventListener('click', function() {
      setLang(document.body.classList.contains('en-mode') ? 'zh' : 'en');
    });
  })();

  // ── Actions (with button loading state) ──────────────────────────────────
  function closeOutput() {
    var out = document.getElementById('output');
    out.classList.remove('visible');
    setTimeout(function() { out.style.display = 'none'; }, 320);
  }

  async function run(event, path) {
    var btn = event && event.currentTarget;
    var origPR = btn ? btn.style.paddingRight : '';
    if (btn) { btn.classList.add('btn-loading'); btn.style.paddingRight = '36px'; }

    var out = document.getElementById('output');
    var body = document.getElementById('output-body');
    var isEn = document.body.classList.contains('en-mode');
    out.style.display = 'block';
    requestAnimationFrame(function() { requestAnimationFrame(function() { out.classList.add('visible'); }); });
    body.textContent = isEn ? '⏳ Requesting...' : '⏳ 请求中……';

    try {
      var res = await fetch(path);
      var text = await res.text();
      try { body.textContent = JSON.stringify(JSON.parse(text), null, 2); }
      catch(e) { body.textContent = text; }
    } catch(e) {
      body.textContent = '❌ ' + e.message;
    } finally {
      if (btn) { btn.classList.remove('btn-loading'); btn.style.paddingRight = origPR; }
    }
  }

  // ── Pro license helpers ───────────────────────────────────────────────────
  var _proExpiresAt = ${(agent as any).pro_expires_at || 0};
  function _isProActive() { return _proExpiresAt > Date.now(); }

  async function runPro(event, path) {
    var isEn = document.body.classList.contains('en-mode');
    if (!_isProActive()) {
      var outEl = document.getElementById('output');
      var bodyEl = document.getElementById('output-body');
      outEl.style.display = 'block';
      requestAnimationFrame(function() { requestAnimationFrame(function() { outEl.classList.add('visible'); }); });
      bodyEl.textContent = isEn
        ? '🔒 Pro license required. Enter your license key above to unlock.'
        : '🔒 需要 Pro 授权码才可使用此功能，请先在上方激活授权码。';
      return;
    }
    return run(event, path);
  }

  async function activateProKey(id) {
    var key = document.getElementById('pro-key-input').value.trim();
    var st = document.getElementById('pro-key-status');
    var isEn = document.body.classList.contains('en-mode');
    if (!key) { st.innerHTML = '<span style="color:#f87171">❌ ' + (isEn ? 'Please enter a key' : '请输入授权码') + '</span>'; return; }
    st.textContent = isEn ? '⏳ Validating...' : '⏳ 验证中...'; st.style.color = '#94a3b8';
    try {
      var r = await fetch('/api/agent/activate-license?id=' + id, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ key })
      });
      var d = await r.json();
      if (d.ok) {
        _proExpiresAt = d.expires_at;
        var until = new Date(d.expires_at).toLocaleDateString(isEn ? 'en-US' : 'zh-CN');
        st.innerHTML = '<span style="color:#86efac">✅ ' + (isEn ? 'Pro activated, valid until ' : 'Pro 已激活，有效至 ') + '<b>' + until + '</b></span>';
      } else {
        st.innerHTML = '<span style="color:#f87171">❌ ' + (d.error || (isEn ? 'Invalid key' : '无效授权码')) + '</span>';
      }
    } catch(e) { st.innerHTML = '<span style="color:#f87171">❌ ' + e.message + '</span>'; }
  }

  async function saveConfig(id) {
    var reply = parseFloat(document.getElementById('cfg-reply').value);
    var like  = parseFloat(document.getElementById('cfg-like').value);
    var st = document.getElementById('cfg-status');
    var isEn = document.body.classList.contains('en-mode');
    st.textContent = isEn ? '⏳ Saving...' : '⏳ 保存中...'; st.style.color = '#94a3b8';
    try {
      var r = await fetch('/api/agent/update-config?id=' + id, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({reply_pct:reply, like_pct:like, cooldown_days:3})
      });
      var d = await r.json();
      st.textContent = d.ok ? (isEn ? '✅ Saved' : '✅ 已保存') : '❌ ' + d.error;
      st.style.color = d.ok ? '#86efac' : '#f87171';
    } catch(e) { st.textContent = '❌ ' + e.message; st.style.color = '#f87171'; }
  }

  async function saveSkill(id) {
    var skill = document.getElementById('skill-text').value.trim();
    var st = document.getElementById('skill-status');
    var isEn = document.body.classList.contains('en-mode');
    if (!skill) { st.textContent = isEn ? '⚠️ Cannot be empty' : '⚠️ 不能为空'; st.style.color = '#fbbf24'; return; }
    st.textContent = isEn ? '⏳ Saving...' : '⏳ 保存中...'; st.style.color = '#94a3b8';
    try {
      var r = await fetch('/api/agent/update-skill?id=' + id, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({skill})
      });
      var d = await r.json();
      st.textContent = d.ok ? (isEn ? '✅ Saved' : '✅ 已保存') : '❌ ' + d.error;
      st.style.color = d.ok ? '#86efac' : '#f87171';
    } catch(e) { st.textContent = '❌ ' + e.message; st.style.color = '#f87171'; }
  }

  async function updateDashSecret(id) {
    var secret = document.getElementById('dash-secret-update').value.trim();
    var st = document.getElementById('secret-status');
    var isEn = document.body.classList.contains('en-mode');
    if (!secret) { st.textContent = isEn ? '⚠️ Cannot be empty' : '⚠️ 不能为空'; st.style.color = '#fbbf24'; return; }
    st.textContent = isEn ? '⏳ Saving...' : '⏳ 保存中...'; st.style.color = '#94a3b8';
    try {
      var r = await fetch('/api/agent/update-secret?id=' + id, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({secret})
      });
      var d = await r.json();
      st.textContent = d.ok ? (isEn ? '✅ Saved' : '✅ 已保存') : '❌ ' + d.error;
      st.style.color = d.ok ? '#86efac' : '#f87171';
      if (d.ok) {
        sessionStorage.setItem('dashSecret', secret);
        document.getElementById('dash-secret-update').value = '';
      }
    } catch(e) { st.textContent = '❌ ' + e.message; st.style.color = '#f87171'; }
  }

  // ── Re-authorize ─────────────────────────────────────────────────────────
  async function doReauth(id) {
    var btn = document.getElementById('reauthBtn');
    var st = document.getElementById('reauth-status');
    var isEn = document.body.classList.contains('en-mode');
    btn.disabled = true;
    st.textContent = isEn ? '⏳ Opening auth window...' : '⏳ 正在打开授权窗口...';
    st.style.color = '#94a3b8';

    try {
      var r = await fetch('/api/agent/reauth-start?id=' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentOrigin: window.location.origin })
      });
      var d = await r.json();
      if (d.error) { st.textContent = '❌ ' + d.error; st.style.color = '#f87171'; btn.disabled = false; return; }

      var authWin = window.open(d.authUrl, '_blank', 'width=600,height=700');
      st.textContent = isEn ? '⏳ Waiting for authorization...' : '⏳ 等待授权回调中……';

      var pollTimer = setInterval(async function() {
        try {
          var res = await fetch('/api/oauth/result?sessionId=' + encodeURIComponent(d.sessionId));
          var s = await res.json();
          if (s.status === 'done') {
            clearInterval(pollTimer);
            if (authWin && !authWin.closed) authWin.close();
            st.textContent = isEn ? '✅ Re-authorized! New token saved.' : '✅ 重新授权成功！新 Token 已写入。';
            st.style.color = '#86efac';
            btn.disabled = false;
          } else if (s.status === 'error') {
            clearInterval(pollTimer);
            st.textContent = '❌ ' + (s.error || 'OAuth failed');
            st.style.color = '#f87171';
            btn.disabled = false;
          }
        } catch(e) {
          clearInterval(pollTimer);
          st.textContent = '❌ ' + e.message;
          st.style.color = '#f87171';
          btn.disabled = false;
        }
      }, 1500);

      // Auto-clean up if window is closed without completing
      var closedTimer = setInterval(function() {
        if (authWin && authWin.closed) {
          clearInterval(closedTimer);
          clearInterval(pollTimer);
          if (st.textContent.includes('⏳')) {
            st.textContent = isEn ? '⚠️ Window closed before completing.' : '⚠️ 授权窗口已关闭，请重试。';
            st.style.color = '#fbbf24';
            btn.disabled = false;
          }
        }
      }, 1000);
    } catch(e) {
      st.textContent = '❌ ' + e.message;
      st.style.color = '#f87171';
      btn.disabled = false;
    }
  }
</script>
</body>
</html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // ── KV-only read endpoints (no DB agent lookup required) ─────────────────
    if (pathname === '/api/agent/activity' || pathname === '/api/agent/memory') {
      const agentId = url.searchParams.get('id');
      if (!agentId) return json({ error: 'Missing agent ID' }, 400);
      if (pathname === '/api/agent/activity') return json(await getActivityLog(env, agentId));
      return json(await getInteractionsMemory(env, agentId));
    }

    // ── Individual Agent Admin Actions ─────────────────────────────────────────
    if (pathname.startsWith('/api/agent/')) {
      const agentId = url.searchParams.get('id');
      if (!agentId) return json({ error: 'Missing agent ID' }, 400);

      const agentRaw = await env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(agentId).all();
      if (!agentRaw.results || agentRaw.results.length === 0) return json({ error: 'Agent not found' }, 404);
      const row = agentRaw.results[0] as Record<string, unknown>;
      const agent: AgentDbRecord = {
        ...row,
        source_accounts: JSON.parse((row.source_accounts as string) || '[]'),
        vip_list: JSON.parse((row.vip_list as string) || '[]'),
        mem_whitelist: (row.mem_whitelist === 'all' ? 'all' : JSON.parse((row.mem_whitelist as string) || '[]'))
      } as unknown as AgentDbRecord;

      if (pathname === '/api/agent/status') {
        const lastMentionId = await getLastMentionId(env, agentId);
        return json({ agentName: agent.agent_name, lastMentionId, autoEvo: agent.auto_evo });
      }
      if (pathname === '/api/agent/refresh-memory') {
        try { return json({ ok: true, ...(await runMemoryRefresh(env, agent)) }); } catch (err) { return json({ ok: false, error: String(err) }, 500); }
      }
      if (pathname === '/api/agent/evolve') {
        try { return json({ ok: true, ...(await runNightlyEvolution(env, agent)) }); } catch (err) { return json({ ok: false, error: String(err) }, 500); }
      }
      if (pathname === '/api/agent/trigger') {
        try { return json({ ok: true, ...(await runMentionLoop(env, agent)) }); } catch (err) { return json({ ok: false, error: String(err) }, 500); }
      }
      if (pathname === '/api/agent/trigger-timeline') {
        try { return json({ ok: true, ...(await runTimelineEngagement(env, agent)) }); } catch (err) { return json({ ok: false, error: String(err) }, 500); }
      }
      if (pathname === '/api/agent/spontaneous') {
        const force = url.searchParams.get('force') === 'true';
        try { return json({ ok: true, ...(await runSpontaneousTweet(env, agent, force)) }); } catch (err) { return json({ ok: false, error: String(err) }, 500); }
      }
      if (pathname === '/api/agent/update-config' && method === 'POST') {
        try {
          const body = await request.json() as any;
          const replyPct = parseFloat(body.reply_pct);
          const likePct  = parseFloat(body.like_pct);
          const cooldown = parseFloat(body.cooldown_days);
          if ([replyPct, likePct, cooldown].some(v => isNaN(v))) return json({ error: 'Invalid values' }, 400);
          await env.DB.prepare('UPDATE agents SET reply_pct=?, like_pct=?, cooldown_days=? WHERE id=?')
            .bind(replyPct, likePct, cooldown, agentId).run();
          return json({ ok: true });
        } catch (err) { return json({ ok: false, error: String(err) }, 500); }
      }
      if (pathname === '/api/agent/update-skill' && method === 'POST') {
        try {
          const body = await request.json() as any;
          const skill = (body.skill ?? '').trim();
          if (!skill) return json({ error: 'Skill text is empty' }, 400);
          await env.DB.prepare('UPDATE agents SET skill_text=? WHERE id=?').bind(skill, agentId).run();
          return json({ ok: true });
        } catch (err) { return json({ ok: false, error: String(err) }, 500); }
      }
      if (pathname === '/api/agent/update-secret' && method === 'POST') {
        try {
          const body = await request.json() as any;
          const secret = (body.secret ?? '').trim();
          if (!secret) return json({ error: 'Secret is empty' }, 400);
          await env.DB.prepare('UPDATE agents SET agent_secret=? WHERE id=?').bind(secret, agentId).run();
          return json({ ok: true });
        } catch (err) { return json({ ok: false, error: String(err) }, 500); }
      }
      if (pathname === '/api/agent/twitter-identity') {
        try {
          const accessToken = await getValidAccessToken(env, agent);
          const meRes = await fetch('https://api.twitter.com/2/users/me', {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (!meRes.ok) throw new Error(`Twitter API ${meRes.status}: ${await meRes.text()}`);
          const meData = await meRes.json() as any;
          const twitterName: string = meData.data?.name ?? '';
          const twitterHandle: string = meData.data?.username ?? '';
          if (twitterName || twitterHandle) {
            await env.DB.prepare('UPDATE agents SET agent_name=?, agent_handle=? WHERE id=?')
              .bind(twitterName, twitterHandle, agentId).run();
          }
          return json({ name: twitterName, username: twitterHandle });
        } catch (err) { return json({ error: String(err) }, 500); }
      }
      if (pathname === '/api/agent/update-whitelist' && method === 'POST') {
        try {
          const body = await request.json() as any;
          const wl = body.whitelist;
          if (wl !== 'all' && !Array.isArray(wl)) return json({ error: 'whitelist must be "all" or an array' }, 400);
          const stored = wl === 'all' ? 'all' : JSON.stringify((wl as string[]).map((h: string) => h.replace(/^@/, '').trim()).filter(Boolean));
          await env.DB.prepare('UPDATE agents SET mem_whitelist=? WHERE id=?').bind(stored, agentId).run();
          return json({ ok: true });
        } catch (err) { return json({ ok: false, error: String(err) }, 500); }
      }
      if (pathname === '/api/agent/update-vip' && method === 'POST') {
        try {
          const body = await request.json() as any;
          if (!Array.isArray(body.vip_list)) return json({ error: 'vip_list must be an array' }, 400);
          await env.DB.prepare('UPDATE agents SET vip_list=? WHERE id=?').bind(JSON.stringify(body.vip_list), agentId).run();
          return json({ ok: true });
        } catch (err) { return json({ ok: false, error: String(err) }, 500); }
      }
      return json({ error: 'Unknown agent action' }, 404);
    }

    // Undefined route
    return json({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;

function resSortModelsList(models: string[]) {
  models.sort((a, b) => {
    // Put 2.5 > 2.0 > 1.5; pro > flash > nano
    const rank = (s: string) =>
      (s.includes('2.5') ? 300 : s.includes('2.0') ? 200 : s.includes('1.5') ? 100 : 0) +
      (s.includes('pro') ? 30 : s.includes('flash') ? 20 : s.includes('nano') ? 10 : 0);
    return rank(b) - rank(a);
  });
}
