import type { Env, AgentDbRecord } from './types.ts';
import { runMentionLoop, runSpontaneousTweet, runTimelineEngagement, runMemoryRefresh, runNightlyEvolution, runRefreshSourceNames } from './agent.ts';

export async function getAllActiveAgents(env: Env): Promise<AgentDbRecord[]> {
  const { results } = await env.DB.prepare('SELECT * FROM agents WHERE status = "active"').all();
  if (!results) return [];
  return results.map(row => ({
    ...row,
    source_accounts: JSON.parse((row.source_accounts as string) || '[]'),
    vip_list: JSON.parse((row.vip_list as string) || '[]'),
    mem_whitelist: (row.mem_whitelist === 'all' ? 'all' : JSON.parse((row.mem_whitelist as string) || '[]'))
  })) as unknown as AgentDbRecord[];
}

export async function runScheduled(cron: string | undefined, env: Env, ctx: ExecutionContext): Promise<void> {
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
  // Refresh source account display names once a day at UTC 02:00
  const isSourceNameRefresh = hours === 2 && mins === 0;

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
    if (isSourceNameRefresh || cron === '0 2 * * *') {
      ctx.waitUntil(runRefreshSourceNames(env, agent).catch(e => console.error(`[worker] source name refresh error for ${agent.id}:`, e)));
    }
  }
}
