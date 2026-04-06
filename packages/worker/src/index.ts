import type { Env, AgentDbRecord } from './types.ts';
import { runMentionLoop, runSpontaneousTweet, runTimelineEngagement, runMemoryRefresh, runNightlyEvolution } from './agent.ts';
import { getMe, getUserByUsername, getUserTweets } from './twitter.ts';
import { getLastMentionId, getCachedOwnUserId, getInteractionsMemory, getActivityLog } from './memory.ts';
import { GoogleGenAI } from '@google/genai';
import { fetchSourceTweets, distillSkillFromTweets, genSample, refineSkill } from './builder.ts';

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

    if (pathname === '/api/oauth/start' && method === 'POST') {
      const sessionId = crypto.randomUUID();
      const codeVerifier = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''); // 64 chars
      
      const encoder = new TextEncoder();
      const data = encoder.encode(codeVerifier);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const codeChallenge = btoa(String.fromCharCode.apply(null, hashArray)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      
      const state = crypto.randomUUID().replace(/-/g, '');

      const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', env.X_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', url.origin + '/callback');
      authUrl.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      const sessionData = { state, codeVerifier, status: 'pending' };
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

      const renderAuthUI = (title: string, subtitle: string, isError: boolean = false) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:'Inter',system-ui,-apple-system;background:#09090b;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;overflow:hidden;position:relative}.blob{position:absolute;border-radius:50%;filter:blur(80px);z-index:-1;opacity:0.5}.b1{width:300px;height:300px;background:radial-gradient(circle,#c1939b 0%,transparent 70%);top:-50px;left:-50px}.b2{width:400px;height:400px;background:radial-gradient(circle,#ebb5b2 0%,transparent 70%);bottom:-100px;right:-100px}.c{background:rgba(24,24,27,0.6);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:48px 32px;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);z-index:10;max-width:400px}h2{color:${isError ? '#ef4444' : '#c1939b'};margin-top:0;font-size:1.5rem}p{color:#a1a1aa;line-height:1.6}.close{font-size:13px;color:#71717a;margin-top:24px}</style></head><body><div class="blob b1"></div><div class="blob b2"></div><div class="c"><h2>${isError ? '❌' : '✅'} ${title}</h2><p>${subtitle}</p><p class="close">这个页面可以安全退出了</p></div></body></html>`;

      if (!state) return new Response(renderAuthUI('参数错误', '缺少 state 参数。', true), { status: 400, headers: {'Content-Type':'text/html; charset=utf-8'} });
      const sessionId = await env.AGENT_STATE.get('oauth_state:' + state);
      if (!sessionId) return new Response(renderAuthUI('授权过期', 'Session 已失效，请回向导页重试。', true), { status: 400, headers: {'Content-Type':'text/html; charset=utf-8'} });
      
      const sessionRaw = await env.AGENT_STATE.get('oauth:' + sessionId);
      if (!sessionRaw) return new Response(renderAuthUI('授权过期', 'Session 已失效，请回向导页重试。', true), { status: 400, headers: {'Content-Type':'text/html; charset=utf-8'} });
      const session = JSON.parse(sessionRaw);

      if (error) {
        session.status = 'error'; session.error = error;
        await env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(session), { expirationTtl: 600 });
        return new Response(renderAuthUI('授权被拒', '您已拒绝授权，请关闭此页。', true), { headers: {'Content-Type':'text/html; charset=utf-8'} });
      }

      const creds = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
      const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
        body: new URLSearchParams({
          code: code || '', grant_type: 'authorization_code', redirect_uri: (new URL(request.url)).origin + '/callback',
          code_verifier: session.codeVerifier, client_id: env.X_CLIENT_ID,
        }).toString(),
      });
      const data = await tokenRes.json() as any;
      if (!tokenRes.ok || !data.access_token) {
        session.status = 'error'; session.error = JSON.stringify(data);
        await env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(session), { expirationTtl: 600 });
        return new Response(renderAuthUI('获取令牌失败', '与 X API 交换凭据失败，请重试。', true), { status: 500, headers: {'Content-Type':'text/html; charset=utf-8'} });
      }

      session.status = 'done';
      session.accessToken = data.access_token;
      session.refreshToken = data.refresh_token;
      await env.AGENT_STATE.put('oauth:' + sessionId, JSON.stringify(session), { expirationTtl: 600 });

      return new Response(renderAuthUI('授权成功', '您的 X 账号已成功关联。请回到原部署向导页。'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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
        const { sourceAccounts, accessToken, geminiApiKey, geminiModel } = reqJson;
        const tweetsByAccount = await fetchSourceTweets(sourceAccounts, accessToken);
        const accountCount = Object.keys(tweetsByAccount).length;
        if (accountCount === 0) return json({ error: 'No tweets fetched. Check accounts/token.' }, 400);
        
        const skill = await distillSkillFromTweets(tweetsByAccount, geminiApiKey, geminiModel);
        const fetched: Record<string, number> = {};
        for (const [k, v] of Object.entries(tweetsByAccount)) fetched[k] = v.length;
        return json({ skill, fetched });
      } catch (err) { return json({ error: String(err) }, 500); }
    }

    if (pathname === '/api/tune/sample' && method === 'POST') {
      try {
        const reqJson = await request.json() as any;
        const { skill, geminiApiKey, geminiModel } = reqJson;
        return json(await genSample(skill, geminiApiKey, geminiModel));
      } catch (err) { return json({ error: String(err) }, 500); }
    }

    if (pathname === '/api/tune/refine' && method === 'POST') {
      try {
        const reqJson = await request.json() as any;
        const { skill, feedback, geminiApiKey, geminiModel } = reqJson;
        return json({ skill: await refineSkill(skill, feedback, geminiApiKey, geminiModel) });
      } catch (err) { return json({ error: String(err) }, 500); }
    }

    if (pathname === '/api/models' && method === 'GET') {
      const key = url.searchParams.get('key');
      if (!key) return json({ error: 'Missing key' }, 400);
      try {
        const ai = new GoogleGenAI({ apiKey: key });
        const models: string[] = [];
        const pager = await ai.models.list();
        for await (const m of pager) {
          const name = m.name ?? '';
          if (name.includes('gemini')) {
            models.push(name.replace(/^models\//, ''));
          }
        }
        resSortModelsList(models);
        return json({ models });
      } catch (err) { return json({ error: String(err) }, 400); }
    }

    if (pathname === '/api/save' && method === 'POST') {
      try {
        const reqJson = await request.json() as any;
        const config = reqJson.config;
        const skill = reqJson.skill;
        const refreshToken = reqJson.refreshToken;
        const geminiApiKey = reqJson.geminiApiKey;

        const agentId = crypto.randomUUID();
        const ownerId = "public"; // Currently placeholder until auth wrapper 

        await env.DB.prepare(`
          INSERT INTO agents (
            id, owner_id, agent_name, agent_handle, source_accounts, gemini_model, gemini_api_key, 
            refresh_token, access_token, token_expires_at, skill_text, reply_pct, like_pct, 
            cooldown_days, auto_evo, vip_list, mem_whitelist, created_at, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, null, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `).bind(
          agentId, ownerId, config.agentName, config.agentHandle, JSON.stringify(config.sourceAccounts), config.geminiModel, geminiApiKey,
          refreshToken, skill, config.defaultReplyProbability, config.defaultLikeProbability,
          config.spontaneousCooldownDays, config.enableNightlyEvolution ? 1 : 0, 
          JSON.stringify(config.vipList), config.memoryWhitelist === 'all' ? 'all' : JSON.stringify(config.memoryWhitelist), Date.now()
        ).run();

        // return the dashboard link!
        return json({ success: true, agentId, redirect: `/dashboard?id=${agentId}` });
      } catch (err) { return json({ error: String(err) }, 500); }
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

      const base = url.origin;

      const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${agent.agent_name} · Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:#080810;color:#e2e8f0;min-height:100vh;padding:2rem}
    h1{font-size:1.6rem;font-weight:700;margin-bottom:.2rem;background:linear-gradient(135deg,#a78bfa,#60a5fa,#34d399);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
    .sub{color:#4a5568;font-size:.85rem;margin-bottom:2rem}
    .badge{display:inline-block;padding:.15rem .5rem;background:rgba(167,139,250,.15);border:1px solid rgba(167,139,250,.3);border-radius:4px;font-size:.75rem;color:#a78bfa;margin-left:.5rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem}
    .card{background:#0f0f1a;border:1px solid #1e1e2e;border-radius:14px;padding:1.25rem;transition:border-color .2s}
    .card:hover{border-color:#2d2d45}
    .card h2{font-size:.875rem;font-weight:600;color:#a78bfa;margin-bottom:.5rem}
    .card p{font-size:.8rem;color:#6b7280;margin-bottom:1rem;line-height:1.55}
    .btn{display:inline-block;padding:.45rem 1rem;border-radius:8px;font-size:.8rem;font-weight:600;text-decoration:none;cursor:pointer;transition:all .15s;border:none}
    .btn-primary{background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff}
    .btn-secondary{background:#1e1e2e;color:#94a3b8;border:1px solid #2d2d3d}
    .btn-purple{background:linear-gradient(135deg,#7c3aed,#9333ea);color:#fff}
    .btn:hover{opacity:.85;transform:translateY(-1px)}
    #output{margin-top:1.5rem;background:#0a0a14;border:1px solid #1e1e2e;border-radius:12px;padding:1.25rem;white-space:pre-wrap;font-family:'JetBrains Mono',monospace;font-size:.78rem;color:#86efac;min-height:80px;display:none;line-height:1.6}
    .wide{grid-column:1/-1}
    textarea{width:100%;margin-bottom:.75rem;background:#080810;color:#e2e8f0;border:1px solid #1e1e2e;padding:.6rem;border-radius:8px;font-size:.82rem;resize:vertical;outline:none;transition:border-color .2s}
    textarea:focus{border-color:#7c3aed}
    .vip-list{font-size:.75rem;color:#6b7280;margin-top:.5rem}
    .vip-chip{display:inline-block;padding:.1rem .4rem;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.2);border-radius:4px;color:#fbbf24;margin:.1rem}
  </style>
</head>
<body>
  <h1>🤖 ${agent.agent_name} · Admin<span class="badge">@${agent.agent_handle}</span></h1>
  <p class="sub">Tenant ID: ${agent.id} · Powered by Cloudflare D1</p>

  <div class="vip-list">
    VIPs: ${vipList.map((v: any) => `<span class="vip-chip">@${v.username}${v.persona ? ` · ${v.persona}` : ''}</span>`).join('')}
  </div>
  <br/>

  <div class="grid">
    <div class="card">
      <h2>📬 回复提及</h2>
      <p>立即扫描新的 @mention 并生成回复（等同于 1 分钟内的循环）</p>
      <a class="btn btn-primary" href="#" onclick="run('/api/agent/trigger?id=${agentId}');return false">立即触发</a>
    </div>

    <div class="card">
      <h2>👀 刷时间线</h2>
      <p>扫描关注/粉丝列表，随机点赞或回复 2 条最新推文</p>
      <a class="btn btn-primary" href="#" onclick="run('/api/agent/trigger-timeline?id=${agentId}');return false">浏览时间线</a>
    </div>

    <div class="card">
      <h2>💬 自发推文</h2>
      <p>随机生成并发布一条自发推文（${agent.cooldown_days} 天冷却）</p>
      <a class="btn btn-primary" href="#" onclick="run('/api/agent/spontaneous?id=${agentId}');return false">发推文</a>
      &nbsp;
      <a class="btn btn-secondary" href="#" onclick="run('/api/agent/spontaneous?id=${agentId}&force=true');return false">强制发</a>
    </div>

    <div class="card">
      <h2>🧠 互动记忆</h2>
      <p>查看白名单用户塑造 Agent 的历史互动记录</p>
      <a class="btn btn-secondary" target="_blank" href="${base}/api/agent/memory?id=${agentId}">查看记忆</a>
      &nbsp;
      <a class="btn btn-primary" href="#" onclick="run('/api/agent/refresh-memory?id=${agentId}');return false">拉取最新</a>
    </div>

    <div class="card" style="border-color:#7c3aed">
      <h2 style="color:#c084fc">🧬 人格演化</h2>
      <p>手动触发：吸收现有记忆彻底充实底仓性格（执行后清空现有记忆库）</p>
      <a class="btn btn-purple" href="#" onclick="run('/api/agent/evolve?id=${agentId}');return false">强制重塑底层人格</a>
    </div>

    <div class="card">
      <h2>📊 Agent 状态</h2>
      <p>查看当前状态（last mention ID、config 信息等）</p>
      <a class="btn btn-secondary" href="#" onclick="run('/api/agent/status?id=${agentId}');return false">查看</a>
    </div>

    <div class="card" style="border-color:#3b82f6">
      <h2 style="color:#60a5fa">📡 神经脉冲活动</h2>
      <p>雷达监控：查看 Agent 近期所有隐秘动作（阅读、点赞、回复、推文）</p>
      <a class="btn btn-secondary" target="_blank" href="${base}/api/agent/activity?id=${agentId}">拉取监控日志</a>
    </div>
  </div>

  <pre id="output"></pre>

  <script>
    async function run(path) {
      const out = document.getElementById('output');
      out.style.display = 'block';
      out.textContent = '⏳ 请求中...';
      try {
        const res = await fetch(path);
        const text = await res.text();
        try { out.textContent = JSON.stringify(JSON.parse(text), null, 2); }
        catch { out.textContent = text; }
      } catch(e) { out.textContent = '❌ ' + e.message; }
    }
  </script>
</body>
</html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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
      if (pathname === '/api/agent/activity') {
        return json(await getActivityLog(env, agentId));
      }
      if (pathname === '/api/agent/memory') {
        return json(await getInteractionsMemory(env, agentId));
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
