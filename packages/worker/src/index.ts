import type { Env } from './types.ts';
import { runMentionLoop, runSpontaneousTweet, runTimelineEngagement, runMemoryRefresh, runNightlyEvolution } from './agent.ts';
import { getMe, getUserByUsername, getUserTweets } from './twitter.ts';
import { getSkill, saveSkill, getLastMentionId, getCachedOwnUserId, getInteractionsMemory, getActivityLog } from './memory.ts';
import { agentConfig } from './config.ts';

export default {
  // ── Cron Triggers ────────────────────────────────────────────────────────────
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = controller.cron;
    console.log(`[worker] Cron triggered: ${cron}`);

    const schedules = agentConfig.cronSchedules;

    if (cron === schedules.mentionPoll) {
      // Loop 4 times for sub-minute polling (every ~15 seconds within the 1-min window)
      ctx.waitUntil((async () => {
        for (let i = 0; i < 4; i++) {
          const runStart = Date.now();
          await runMentionLoop(env).catch(e => console.error('[worker] mention loop error:', e));
          const elapsed = Date.now() - runStart;
          const remaining = 15000 - elapsed;
          if (i < 3 && remaining > 0) {
            await new Promise(r => setTimeout(r, remaining));
          }
        }
      })());

    } else if (cron === schedules.timelineEngagement) {
      ctx.waitUntil(runTimelineEngagement(env));

    } else if (cron === schedules.spontaneous) {
      ctx.waitUntil(runSpontaneousTweet(env));

    } else if (cron === schedules.memoryRefresh) {
      ctx.waitUntil(runMemoryRefresh(env).catch(e => console.error('[worker] memory refresh error:', e)));

    } else if (cron === schedules.nightlyEvolution) {
      ctx.waitUntil(runNightlyEvolution(env).catch(e => console.error('[worker] nightly evolution error:', e)));

    } else {
      console.warn(`[worker] Unknown cron pattern: ${cron}. Check cronSchedules in config.json matches wrangler.toml.`);
    }
  },

  // ── HTTP Handler ──────────────────────────────────────────────────────────────
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname.replace(/\/$/, '') || '/';

    // ── Admin Dashboard ────────────────────────────────────────────────────────

    if (pathname === '/' && method === 'GET') {
      if (!isAdmin(request, env)) {
        return new Response('Unauthorized — append ?secret=YOUR_SECRET to the URL', { status: 401 });
      }
      const s = encodeURIComponent(url.searchParams.get('secret') ?? '');
      const base = url.origin;
      const agentName = agentConfig.agentName;
      const agentHandle = agentConfig.agentHandle;

      const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${agentName} · Admin</title>
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
  <h1>🤖 ${agentName} · Admin<span class="badge">@${agentHandle}</span></h1>
  <p class="sub">Agent Control Dashboard · ${base}</p>

  <div class="vip-list">
    VIPs: ${agentConfig.vipList.map(v => `<span class="vip-chip">@${v.username}${v.persona ? ` · ${v.persona}` : ''}</span>`).join('')}
  </div>
  <br/>

  <div class="grid">
    <div class="card">
      <h2>📬 回复提及</h2>
      <p>立即扫描新的 @mention 并生成回复（等同于 1 分钟内的循环）</p>
      <a class="btn btn-primary" href="#" onclick="run('/trigger?secret=${s}');return false">立即触发</a>
    </div>

    <div class="card">
      <h2>👀 刷时间线</h2>
      <p>扫描关注/粉丝列表，随机点赞或回复 2 条最新推文</p>
      <a class="btn btn-primary" href="#" onclick="run('/trigger-timeline?secret=${s}');return false">浏览时间线</a>
    </div>

    <div class="card">
      <h2>💬 自发推文</h2>
      <p>随机生成并发布一条自发推文（${agentConfig.spontaneousCooldownDays} 天冷却；加 &force=true 强制）</p>
      <a class="btn btn-primary" href="#" onclick="run('/spontaneous?secret=${s}');return false">发推文</a>
      &nbsp;
      <a class="btn btn-secondary" href="#" onclick="run('/spontaneous?secret=${s}&force=true');return false">强制发</a>
    </div>

    <div class="card">
      <h2>🎭 查看 Skill</h2>
      <p>查看当前的人格配置底层 Skill（存储于 KV，可随时迭代进化）</p>
      <a class="btn btn-secondary" target="_blank" href="${base}/skill?secret=${s}">查看</a>
    </div>

    <div class="card">
      <h2>🧠 互动记忆</h2>
      <p>查看白名单用户塑造 Agent 的历史互动记录</p>
      <a class="btn btn-secondary" target="_blank" href="${base}/memory?secret=${s}">查看记忆</a>
      &nbsp;
      <a class="btn btn-primary" href="#" onclick="run('/refresh-memory?secret=${s}');return false">拉取最新</a>
    </div>

    <div class="card" style="border-color:#7c3aed">
      <h2 style="color:#c084fc">🧬 人格演化</h2>
      <p>手动触发：吸收现有记忆彻底充实底仓性格（执行后清空现有记忆库）</p>
      <a class="btn btn-purple" href="#" onclick="run('/evolve?secret=${s}');return false">强制重塑底层人格</a>
    </div>

    <div class="card">
      <h2>📊 Agent 状态</h2>
      <p>查看当前状态（last mention ID、config 信息等）</p>
      <a class="btn btn-secondary" href="#" onclick="run('/status?secret=${s}');return false">查看</a>
    </div>

    <div class="card" style="border-color:#3b82f6">
      <h2 style="color:#60a5fa">📡 神经脉冲活动</h2>
      <p>雷达监控：查看 Agent 近期所有隐秘动作（阅读、点赞、回复、推文）</p>
      <a class="btn btn-secondary" target="_blank" href="${base}/activity?secret=${s}">拉取监控日志</a>
    </div>

    <div class="card">
      <h2>🐦 抓取推文</h2>
      <p>抓取来源账号的原始推文（用于调试人格蒸馏）</p>
      <a class="btn btn-secondary" href="#" onclick="run('/debug/tweets?secret=${s}&max=10');return false">抓取</a>
    </div>

    <div class="card wide">
      <h2>🧪 模拟器 (Simulator)</h2>
      <p>手动粘贴推文内容，测试 Agent 的文本反应（不上链、不发推，校验人设用）</p>
      <textarea id="simText" rows="3" placeholder="在此处输入网友的推文或你想对 Agent 说的话..."></textarea>
      <a class="btn btn-primary" href="#" onclick="runSim();return false">测试反应</a>
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

    async function runSim() {
      const text = document.getElementById('simText').value;
      if(!text.trim()) return;
      const out = document.getElementById('output');
      out.style.display = 'block';
      out.textContent = '⏳ 模拟思考中...';
      try {
        const res = await fetch('/simulate?secret=${s}', { method: 'POST', body: text });
        const outText = await res.text();
        out.textContent = '🤖 ${agentName}: ' + (outText || '(Empty response)');
      } catch(e) { out.textContent = '❌ ' + e.message; }
    }
  </script>
</body>
</html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // GET /health
    if (pathname === '/health' && method === 'GET') {
      return json({ ok: true, ts: new Date().toISOString(), agent: agentConfig.agentName });
    }

    // ── Admin routes (require X-Admin-Secret header or ?secret= param) ─────────

    if (pathname === '/me' && method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const me = await getMe(env);
      return json({ user: me });
    }

    if (pathname === '/status' && method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const lastMentionId = await getLastMentionId(env);
      return json({
        agentName: agentConfig.agentName,
        agentHandle: agentConfig.agentHandle,
        lastMentionId,
        vipCount: agentConfig.vipList.length,
        memoryWhitelist: agentConfig.memoryWhitelist,
        spontaneousCooldownDays: agentConfig.spontaneousCooldownDays,
      });
    }

    if (pathname === '/skill' && method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const skill = await getSkill(env);
      return new Response(skill, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    if (pathname === '/skill' && method === 'PUT') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const body = await request.text();
      if (!body.trim()) return json({ error: 'Skill content must not be empty' }, 400);
      await saveSkill(env, body.trim());
      return json({ ok: true, length: body.trim().length });
    }

    if (pathname === '/memory' && method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const memory = await getInteractionsMemory(env);
      return json(memory);
    }

    if (pathname === '/activity' && method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const logs = await getActivityLog(env);
      return json(logs);
    }

    if (pathname === '/refresh-memory' && (method === 'GET' || method === 'POST')) {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const result = await runMemoryRefresh(env);
        return json({ ok: true, ...result });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    if (pathname === '/evolve' && (method === 'GET' || method === 'POST')) {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const result = await runNightlyEvolution(env);
        return json({ ok: true, ...result });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    if (pathname === '/trigger' && (method === 'GET' || method === 'POST')) {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const result = await runMentionLoop(env);
        return json({ ok: true, result });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    if (pathname === '/trigger-timeline' && (method === 'GET' || method === 'POST')) {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const result = await runTimelineEngagement(env);
        return json({ ok: true, result });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    if (pathname === '/spontaneous' && (method === 'GET' || method === 'POST')) {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const force = url.searchParams.get('force') === 'true';
      try {
        const result = await runSpontaneousTweet(env, force);
        return json({ ok: true, ...result });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    if (pathname === '/simulate' && method === 'POST') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const text = await request.text();
      if (!text.trim()) return json({ error: 'Empty text' }, 400);
      try {
        const { generateReply } = await import('./llm.ts');
        const reply = await generateReply(env, [{ role: 'user', text, authorUsername: 'web_tester' }], 'none');
        return new Response(reply, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      } catch (err) {
        return json({ error: String(err) }, 500);
      }
    }

    // ── Debug routes ───────────────────────────────────────────────────────────

    if (pathname === '/debug/tweets' && method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const maxResults = Number(url.searchParams.get('max') ?? '30');
      const result: Record<string, unknown> = { fetchedAt: new Date().toISOString(), accounts: {} };

      for (const username of agentConfig.sourceAccounts) {
        try {
          const user = await getUserByUsername(env, username);
          if (!user) {
            (result['accounts'] as Record<string, unknown>)[username] = { error: 'User not found' };
            continue;
          }
          const tweets = await getUserTweets(env, user.id, maxResults);
          (result['accounts'] as Record<string, unknown>)[username] = { user, tweetCount: tweets.length, tweets };
        } catch (err) {
          (result['accounts'] as Record<string, unknown>)[username] = { error: String(err) };
        }
      }
      return json(result);
    }

    if (pathname === '/debug/tweet' && method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const tweetId = url.searchParams.get('id');
      if (!tweetId) return json({ error: 'Missing id param' }, 400);
      const { getTweet } = await import('./twitter.ts');
      const tweet = await getTweet(env, tweetId);
      return json({ tweet });
    }

    if (pathname === '/debug/mentions' && method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const { getMentions } = await import('./twitter.ts');
      const ownUserId = await getCachedOwnUserId(env) ?? (await getMe(env)).id;
      const sinceId = url.searchParams.get('since_id');
      const mentions = await getMentions(env, ownUserId, sinceId ?? undefined);
      return json(mentions);
    }

    if (pathname === '/debug/replied' && method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      const tweetId = url.searchParams.get('id');
      if (!tweetId) return json({ error: 'Missing id param' }, 400);
      const { hasReplied } = await import('./memory.ts');
      const replied = await hasReplied(env, tweetId);
      return json({ tweetId, replied });
    }

    if (pathname === '/debug/config' && method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      return json({ config: agentConfig });
    }

    return json({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAdmin(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  const headerSecret = request.headers.get('X-Admin-Secret');
  const paramSecret = url.searchParams.get('secret');
  return headerSecret === env.ADMIN_SECRET || paramSecret === env.ADMIN_SECRET;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
