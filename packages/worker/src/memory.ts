import type { Env, StoredTokens, InteractionMemory, ActivityLog } from './types.ts';

// ─── KV Keys ──────────────────────────────────────────────────────────────────
export const KEYS = {
  TOKENS: (id: string) => `agent:${id}:auth:tokens`,
  LAST_MENTION_ID: (id: string) => `agent:${id}:last_mention_id`,
  OWN_USER_ID: (id: string) => `agent:${id}:own_user_id`,
  sourceUserId: (id: string, username: string) => `agent:${id}:source:userid:${username}`,
  KNOWN_FANS: (id: string) => `agent:${id}:known_fans`,
  LAST_SPONTANEOUS: (id: string) => `agent:${id}:last_spontaneous`,
  RECENT_SPONTANEOUS: (id: string) => `agent:${id}:recent_spontaneous`,
  INTERACTIONS_MEMORY: (id: string) => `agent:${id}:interactions_memory`,
  ACTIVITY_LOG: (id: string) => `agent:${id}:activity_log`,
} as const;

// ─── Token persistence ─────────────────────────────────────────────────────────

export async function getStoredTokens(env: Env, agentId: string): Promise<StoredTokens | null> {
  const raw = await env.AGENT_STATE.get(KEYS.TOKENS(agentId), 'json');
  return raw as StoredTokens | null;
}

export async function saveTokens(env: Env, agentId: string, tokens: StoredTokens): Promise<void> {
  await env.AGENT_STATE.put(KEYS.TOKENS(agentId), JSON.stringify(tokens));
}

// ─── Mention tracking ──────────────────────────────────────────────────────────

export async function getLastMentionId(env: Env, agentId: string): Promise<string | null> {
  return env.AGENT_STATE.get(KEYS.LAST_MENTION_ID(agentId));
}

export async function saveLastMentionId(env: Env, agentId: string, id: string): Promise<void> {
  await env.AGENT_STATE.put(KEYS.LAST_MENTION_ID(agentId), id);
}

// ─── Own user ID caching ──────────────────────────────────────────────────────

export async function getCachedOwnUserId(env: Env, agentId: string): Promise<string | null> {
  return env.AGENT_STATE.get(KEYS.OWN_USER_ID(agentId));
}

export async function saveOwnUserId(env: Env, agentId: string, userId: string): Promise<void> {
  await env.AGENT_STATE.put(KEYS.OWN_USER_ID(agentId), userId, { expirationTtl: 7 * 24 * 3600 });
}

// ─── Source account user ID caching ───────────────────────────────────────────

export async function getCachedSourceUserId(env: Env, agentId: string, username: string): Promise<string | null> {
  return env.AGENT_STATE.get(KEYS.sourceUserId(agentId, username));
}

export async function saveSourceUserId(env: Env, agentId: string, username: string, userId: string): Promise<void> {
  await env.AGENT_STATE.put(KEYS.sourceUserId(agentId, username), userId, { expirationTtl: 7 * 24 * 3600 });
}

// ─── Spontaneous tweet cooldown ────────────────────────────────────────────────

export async function getLastSpontaneous(env: Env, agentId: string): Promise<Date | null> {
  const raw = await env.AGENT_STATE.get(KEYS.LAST_SPONTANEOUS(agentId));
  return raw ? new Date(raw) : null;
}

export async function saveLastSpontaneous(env: Env, agentId: string): Promise<void> {
  await env.AGENT_STATE.put(KEYS.LAST_SPONTANEOUS(agentId), new Date().toISOString());
}

// ─── Recent spontaneous tweets (anti-repetition) ──────────────────────────────
const MAX_RECENT = 10;

export async function getRecentSpontaneous(env: Env, agentId: string): Promise<string[]> {
  const raw = await env.AGENT_STATE.get(KEYS.RECENT_SPONTANEOUS(agentId));
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

export async function appendRecentSpontaneous(env: Env, agentId: string, text: string): Promise<void> {
  const recent = await getRecentSpontaneous(env, agentId);
  const updated = [text, ...recent].slice(0, MAX_RECENT);
  await env.AGENT_STATE.put(KEYS.RECENT_SPONTANEOUS(agentId), JSON.stringify(updated));
}

// ─── Replied mention tracking ──────────────────────────────────────────────────

export async function hasReplied(env: Env, agentId: string, tweetId: string): Promise<boolean> {
  const val = await env.AGENT_STATE.get(`agent:${agentId}:replied:${tweetId}`);
  return val !== null;
}

export async function markReplied(env: Env, agentId: string, tweetId: string): Promise<void> {
  await env.AGENT_STATE.put(`agent:${agentId}:replied:${tweetId}`, '1', { expirationTtl: 30 * 24 * 3600 });
}

// ─── Timeline tracking ────────────────────────────────────────────────────────

export async function hasSeenTimelineTweet(env: Env, agentId: string, tweetId: string): Promise<boolean> {
  const val = await env.AGENT_STATE.get(`agent:${agentId}:timeline_seen:${tweetId}`);
  return val !== null;
}

export async function markTimelineTweetSeen(env: Env, agentId: string, tweetId: string): Promise<void> {
  await env.AGENT_STATE.put(`agent:${agentId}:timeline_seen:${tweetId}`, '1', { expirationTtl: 3 * 24 * 3600 });
}

// ─── Known Fans tracking ───────────────────────────────────────────────────────

export async function addKnownFan(env: Env, agentId: string, username: string): Promise<void> {
  const raw = await env.AGENT_STATE.get(KEYS.KNOWN_FANS(agentId));
  let fans: string[] = [];
  try { if (raw) fans = JSON.parse(raw) as string[]; } catch {}

  if (!fans.includes(username)) {
    fans.unshift(username);
    await env.AGENT_STATE.put(KEYS.KNOWN_FANS(agentId), JSON.stringify(fans.slice(0, 20)));
  }
}

export async function getKnownFans(env: Env, agentId: string): Promise<string[]> {
  const raw = await env.AGENT_STATE.get(KEYS.KNOWN_FANS(agentId));
  try { return raw ? JSON.parse(raw) as string[] : []; } catch { return []; }
}

// ─── Interaction Memory ────────────────────────────────────────────────────────
const MAX_INTERACTIONS = 1000;

export async function getInteractionsMemory(env: Env, agentId: string): Promise<InteractionMemory[]> {
  const raw = await env.AGENT_STATE.get(KEYS.INTERACTIONS_MEMORY(agentId));
  try { return raw ? JSON.parse(raw) as InteractionMemory[] : []; } catch { return []; }
}

export async function appendInteractionsMemory(env: Env, agentId: string, newItems: InteractionMemory[]): Promise<void> {
  const current = await getInteractionsMemory(env, agentId);

  const memoryMap = new Map<string, InteractionMemory>();
  for (const item of current) memoryMap.set(item.id, item);
  for (const item of newItems) memoryMap.set(item.id, item);

  let updated = Array.from(memoryMap.values());
  updated.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (updated.length > MAX_INTERACTIONS) {
    updated = updated.slice(updated.length - MAX_INTERACTIONS);
  }

  await env.AGENT_STATE.put(KEYS.INTERACTIONS_MEMORY(agentId), JSON.stringify(updated));
}

export async function clearInteractionsMemory(env: Env, agentId: string): Promise<void> {
  await env.AGENT_STATE.delete(KEYS.INTERACTIONS_MEMORY(agentId));
}

// ─── Activity Log (Dashboard Tracking) ────────────────────────────────────────
const MAX_ACTIVITY_LOGS = 100;

export async function getActivityLog(env: Env, agentId: string): Promise<ActivityLog[]> {
  const raw = await env.AGENT_STATE.get(KEYS.ACTIVITY_LOG(agentId));
  try { return raw ? JSON.parse(raw) as ActivityLog[] : []; } catch { return []; }
}

export async function logActivity(
  env: Env,
  agentId: string,
  id: string,
  type: ActivityLog['type'],
  content: string,
  targetUsername?: string,
): Promise<void> {
  const current = await getActivityLog(env, agentId);

  let updated = current.filter(item => item.id !== id);
  updated.unshift({ id, type, content, targetUsername, timestamp: Date.now() });

  if (updated.length > MAX_ACTIVITY_LOGS) {
    updated = updated.slice(0, MAX_ACTIVITY_LOGS);
  }

  await env.AGENT_STATE.put(KEYS.ACTIVITY_LOG(agentId), JSON.stringify(updated));
}
