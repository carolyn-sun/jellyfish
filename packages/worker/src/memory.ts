import type { Env, StoredTokens, InteractionMemory, ActivityLog } from './types.ts';

// ─── KV Keys ──────────────────────────────────────────────────────────────────
export const KEYS = {
  TOKENS: 'auth:tokens',
  LAST_MENTION_ID: 'agent:last_mention_id',
  SKILL: 'agent:skill',
  OWN_USER_ID: 'agent:own_user_id',
  sourceUserId: (username: string) => `source:userid:${username}`,
  KNOWN_FANS: 'agent:known_fans',
  LAST_SPONTANEOUS: 'agent:last_spontaneous',
  RECENT_SPONTANEOUS: 'agent:recent_spontaneous',
  INTERACTIONS_MEMORY: 'agent:interactions_memory',
  ACTIVITY_LOG: 'agent:activity_log',
} as const;

// ─── Token persistence ─────────────────────────────────────────────────────────

export async function getStoredTokens(env: Env): Promise<StoredTokens | null> {
  const raw = await env.AGENT_STATE.get(KEYS.TOKENS, 'json');
  return raw as StoredTokens | null;
}

export async function saveTokens(env: Env, tokens: StoredTokens): Promise<void> {
  await env.AGENT_STATE.put(KEYS.TOKENS, JSON.stringify(tokens));
}

// ─── Mention tracking ──────────────────────────────────────────────────────────

export async function getLastMentionId(env: Env): Promise<string | null> {
  return env.AGENT_STATE.get(KEYS.LAST_MENTION_ID);
}

export async function saveLastMentionId(env: Env, id: string): Promise<void> {
  await env.AGENT_STATE.put(KEYS.LAST_MENTION_ID, id);
}

// ─── Skill (persona soul) management ──────────────────────────────────────────
// The initial skill is seeded into KV via `wrangler kv put` after wizard runs.
// If no skill is found in KV, falls back to this generic default.

const DEFAULT_SKILL = `You are a thoughtful AI presence on X (Twitter).
Engage with mentions sincerely, with warmth and wit.
Keep replies concise (under 280 characters) and conversational.
Do NOT include hashtags unless specifically asked.
Do NOT add any preamble — output ONLY the reply text.
If you have nothing meaningful to add, output <skip>.`;

export async function getSkill(env: Env): Promise<string> {
  const stored = await env.AGENT_STATE.get(KEYS.SKILL);
  return stored ?? DEFAULT_SKILL;
}

export async function saveSkill(env: Env, skill: string): Promise<void> {
  await env.AGENT_STATE.put(KEYS.SKILL, skill);
}

// ─── Own user ID caching ──────────────────────────────────────────────────────

export async function getCachedOwnUserId(env: Env): Promise<string | null> {
  return env.AGENT_STATE.get(KEYS.OWN_USER_ID);
}

export async function saveOwnUserId(env: Env, userId: string): Promise<void> {
  await env.AGENT_STATE.put(KEYS.OWN_USER_ID, userId, { expirationTtl: 7 * 24 * 3600 });
}

// ─── Source account user ID caching ───────────────────────────────────────────

export async function getCachedSourceUserId(env: Env, username: string): Promise<string | null> {
  return env.AGENT_STATE.get(KEYS.sourceUserId(username));
}

export async function saveSourceUserId(env: Env, username: string, userId: string): Promise<void> {
  await env.AGENT_STATE.put(KEYS.sourceUserId(username), userId, { expirationTtl: 7 * 24 * 3600 });
}

// ─── Spontaneous tweet cooldown ────────────────────────────────────────────────

export async function getLastSpontaneous(env: Env): Promise<Date | null> {
  const raw = await env.AGENT_STATE.get(KEYS.LAST_SPONTANEOUS);
  return raw ? new Date(raw) : null;
}

export async function saveLastSpontaneous(env: Env): Promise<void> {
  await env.AGENT_STATE.put(KEYS.LAST_SPONTANEOUS, new Date().toISOString());
}

// ─── Recent spontaneous tweets (anti-repetition) ──────────────────────────────
const MAX_RECENT = 10;

export async function getRecentSpontaneous(env: Env): Promise<string[]> {
  const raw = await env.AGENT_STATE.get(KEYS.RECENT_SPONTANEOUS);
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

export async function appendRecentSpontaneous(env: Env, text: string): Promise<void> {
  const recent = await getRecentSpontaneous(env);
  const updated = [text, ...recent].slice(0, MAX_RECENT);
  await env.AGENT_STATE.put(KEYS.RECENT_SPONTANEOUS, JSON.stringify(updated));
}

// ─── Replied mention tracking ──────────────────────────────────────────────────

export async function hasReplied(env: Env, tweetId: string): Promise<boolean> {
  const val = await env.AGENT_STATE.get(`replied:${tweetId}`);
  return val !== null;
}

export async function markReplied(env: Env, tweetId: string): Promise<void> {
  await env.AGENT_STATE.put(`replied:${tweetId}`, '1', { expirationTtl: 30 * 24 * 3600 });
}

// ─── Timeline tracking ────────────────────────────────────────────────────────

export async function hasSeenTimelineTweet(env: Env, tweetId: string): Promise<boolean> {
  const val = await env.AGENT_STATE.get(`timeline_seen:${tweetId}`);
  return val !== null;
}

export async function markTimelineTweetSeen(env: Env, tweetId: string): Promise<void> {
  await env.AGENT_STATE.put(`timeline_seen:${tweetId}`, '1', { expirationTtl: 3 * 24 * 3600 });
}

// ─── Known Fans tracking ───────────────────────────────────────────────────────
// Anyone who mentions the agent gets registered here for timeline stalking

export async function addKnownFan(env: Env, username: string): Promise<void> {
  const raw = await env.AGENT_STATE.get(KEYS.KNOWN_FANS);
  let fans: string[] = [];
  try { if (raw) fans = JSON.parse(raw) as string[]; } catch {}

  if (!fans.includes(username)) {
    fans.unshift(username);
    await env.AGENT_STATE.put(KEYS.KNOWN_FANS, JSON.stringify(fans.slice(0, 20)));
  }
}

export async function getKnownFans(env: Env): Promise<string[]> {
  const raw = await env.AGENT_STATE.get(KEYS.KNOWN_FANS);
  try { return raw ? JSON.parse(raw) as string[] : []; } catch { return []; }
}

// ─── Interaction Memory ────────────────────────────────────────────────────────
const MAX_INTERACTIONS = 1000;

export async function getInteractionsMemory(env: Env): Promise<InteractionMemory[]> {
  const raw = await env.AGENT_STATE.get(KEYS.INTERACTIONS_MEMORY);
  try { return raw ? JSON.parse(raw) as InteractionMemory[] : []; } catch { return []; }
}

export async function appendInteractionsMemory(env: Env, newItems: InteractionMemory[]): Promise<void> {
  const current = await getInteractionsMemory(env);

  const memoryMap = new Map<string, InteractionMemory>();
  for (const item of current) memoryMap.set(item.id, item);
  for (const item of newItems) memoryMap.set(item.id, item);

  let updated = Array.from(memoryMap.values());
  updated.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (updated.length > MAX_INTERACTIONS) {
    updated = updated.slice(updated.length - MAX_INTERACTIONS);
  }

  await env.AGENT_STATE.put(KEYS.INTERACTIONS_MEMORY, JSON.stringify(updated));
}

export async function clearInteractionsMemory(env: Env): Promise<void> {
  await env.AGENT_STATE.delete(KEYS.INTERACTIONS_MEMORY);
}

// ─── Activity Log (Dashboard Tracking) ────────────────────────────────────────
const MAX_ACTIVITY_LOGS = 100;

export async function getActivityLog(env: Env): Promise<ActivityLog[]> {
  const raw = await env.AGENT_STATE.get(KEYS.ACTIVITY_LOG);
  try { return raw ? JSON.parse(raw) as ActivityLog[] : []; } catch { return []; }
}

export async function logActivity(
  env: Env,
  id: string,
  type: ActivityLog['type'],
  content: string,
  targetUsername?: string,
): Promise<void> {
  const current = await getActivityLog(env);

  let updated = current.filter(item => item.id !== id);
  updated.unshift({ id, type, content, targetUsername, timestamp: Date.now() });

  if (updated.length > MAX_ACTIVITY_LOGS) {
    updated = updated.slice(0, MAX_ACTIVITY_LOGS);
  }

  await env.AGENT_STATE.put(KEYS.ACTIVITY_LOG, JSON.stringify(updated));
}
