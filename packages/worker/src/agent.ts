import type { Env, AgentDbRecord, ConversationTurn, XMedia, XTweet, InteractionMemory } from './types.ts';
import {
  getMentions,
  fetchThreadContext,
  postTweet,
  getMe,
  getUserByUsername,
  getUserTweets,
  likeTweet,
  buildMediaMap,
  describeMedia,
  buildUserMap,
  getTweetReplies,
} from './twitter.ts';
import { generateReply, generateSpontaneousTweet, evaluateTimelineTweet, evolvePersonalitySkill } from './llm.ts';
import {
  getLastMentionId,
  saveLastMentionId,
  getCachedOwnUserId,
  saveOwnUserId,
  getCachedSourceUserId,
  saveSourceUserId,
  getLastSpontaneous,
  saveLastSpontaneous,
  getRecentSpontaneous,
  appendRecentSpontaneous,
  hasReplied,
  markReplied,
  hasSeenTimelineTweet,
  logActivity,
  markTimelineTweetSeen,
  addKnownFan,
  getKnownFans,
  appendInteractionsMemory,
  getInteractionsMemory,
  clearInteractionsMemory,
  getSourceNames,
  saveSourceNames,
} from './memory.ts';

// Max mentions to process in a single cron run
const MAX_PROCESS_PER_RUN = 5;

// Max number of times this agent may reply in a single thread before bailing out
const MAX_THREAD_DEPTH = 2;

// KV TTL for the cached bot-handle set (5 minutes)
const BOT_HANDLE_CACHE_TTL = 300;

// ─── Resolve own user ID (cached in KV) ───────────────────────────────────────
async function resolveOwnUserId(env: Env, agent: AgentDbRecord): Promise<string> {
  const cached = await getCachedOwnUserId(env, agent.id);
  if (cached) return cached;

  const me = await getMe(env, agent);
  await saveOwnUserId(env, agent.id, me.id);
  console.log(`[agent ${agent.id}] Own user ID resolved: @${me.username} (${me.id})`);
  return me.id;
}

// ─── Load all active agent handles (cached in KV, refreshed every 5 min) ──────
// Used to detect cross-agent reply loops before spending any LLM tokens.
async function getKnownBotHandles(env: Env): Promise<Set<string>> {
  const CACHE_KEY = 'platform:bot_handles_cache';
  const cached = await env.AGENT_STATE.get(CACHE_KEY);
  if (cached) {
    try { return new Set(JSON.parse(cached) as string[]); } catch { /* fall through */ }
  }
  try {
    const { results } = await env.DB.prepare(
      'SELECT LOWER(agent_handle) as h FROM agents WHERE status = "active" AND agent_handle != ""'
    ).all();
    const handles = (results ?? []).map(r => (r as any).h as string).filter(Boolean);
    await env.AGENT_STATE.put(CACHE_KEY, JSON.stringify(handles), { expirationTtl: BOT_HANDLE_CACHE_TTL });
    return new Set(handles);
  } catch {
    return new Set(); // on DB error, fail open (don't block all replies)
  }
}

// ─── Load all active agent Twitter user IDs (from KV own_user_id caches) ───────
// This is the immutable-ID companion to getKnownBotHandles.
// KV reads are done in parallel to minimise latency.
async function getKnownBotUserIds(env: Env): Promise<Set<string>> {
  const CACHE_KEY = 'platform:bot_userids_cache';
  const cached = await env.AGENT_STATE.get(CACHE_KEY);
  if (cached) {
    try { return new Set(JSON.parse(cached) as string[]); } catch { /* fall through */ }
  }
  try {
    const { results } = await env.DB.prepare(
      'SELECT id FROM agents WHERE status = "active"'
    ).all();
    const agentIds = (results ?? []).map(r => (r as any).id as string).filter(Boolean);
    // Fetch each agent's cached Twitter user ID from KV in parallel
    const userIds = (await Promise.all(
      agentIds.map(id => env.AGENT_STATE.get(`agent:${id}:own_user_id`))
    )).filter((uid): uid is string => uid !== null);
    await env.AGENT_STATE.put(CACHE_KEY, JSON.stringify(userIds), { expirationTtl: BOT_HANDLE_CACHE_TTL });
    return new Set(userIds);
  } catch {
    return new Set(); // fail open
  }
}

// ─── Resolve a source account's user ID (cached in KV) ───────────────────────
async function resolveSourceUserId(env: Env, agent: AgentDbRecord, username: string): Promise<string | null> {
  const cached = await getCachedSourceUserId(env, agent.id, username);
  if (cached) return cached;

  const user = await getUserByUsername(env, agent, username);
  if (!user) {
    console.warn(`[agent ${agent.id}] Could not resolve user ID for @${username}`);
    return null;
  }

  await saveSourceUserId(env, agent.id, username, user.id);
  console.log(`[agent ${agent.id}] Source account @${username} resolved: ${user.id}`);
  return user.id;
}

// ─── Convert tweet chain → LLM-friendly conversation turns ───────────────────
function threadToConversation(
  tweets: Array<{ id: string; text: string; author_id?: string; attachments?: { media_keys?: string[] } }>,
  ownUserId: string,
  mediaMap: Map<string, XMedia>,
  userMap: Map<string, string>,
): ConversationTurn[] {
  return tweets.map(tweet => {
    const mediaNote = describeMedia(
      tweet as Parameters<typeof describeMedia>[0],
      mediaMap,
    ) ?? undefined;

    const authorUsername = tweet.author_id ? userMap.get(tweet.author_id) : undefined;

    return {
      role: tweet.author_id === ownUserId ? 'agent' : 'user',
      text: tweet.text,
      authorId: tweet.author_id,
      authorUsername,
      mediaNote,
    };
  });
}

// ─── Check if username qualifies for memory absorption ────────────────────────
function shouldAbsorbToMemory(agent: AgentDbRecord, username: string): boolean {
  const whitelist = agent.mem_whitelist;
  if (whitelist === 'all') return true;
  return whitelist.includes(username);
}

// ─── Check if agent has a valid Pro license ──────────────────────────────────────────────────────────────
// pro_expires_at is stored as days since Unix epoch (same unit as the API writes it)
// When ENABLE_SUBSCRIPTIONS=0 the subscription gate is bypassed and all agents are Pro.
export function isAgentPro(env: Env, agent: AgentDbRecord): boolean {
  if ((env.ENABLE_SUBSCRIPTIONS ?? '1') === '0') return true;
  const expiresDay = (agent as any).pro_expires_at as number | undefined;
  if (!expiresDay || expiresDay <= 0) return false;
  const todayDay = Math.floor(Date.now() / 86_400_000);
  return expiresDay >= todayDay;
}

// \u2500\u2500\u2500 Process a single mention \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function processMention(
  env: Env,
  agent: AgentDbRecord,
  mention: XTweet,
  ownUserId: string,
  mediaMap: Map<string, XMedia>,
  userMap: Map<string, string>,
  botHandles: Set<string>,
  botUserIds: Set<string>,
): Promise<boolean> {
  const originalTweetId = mention.edit_history_tweet_ids?.[0] ?? mention.id;

  // \u2500\u2500 Guard 0: Already handled (replied or permanently skipped) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (await hasReplied(env, agent.id, originalTweetId)) {
    console.log(`[agent ${agent.id}] Mention ${originalTweetId} already handled \u2014 skipping`);
    return true;
  }

  // \u2500\u2500 Guard 1: Concurrency lock \u2014 short TTL (2 min) so a crashed run never permanently
  // blocks retries. Unlike markReplied (30 days), this lock expires on its own.
  const inProgressKey = `agent:${agent.id}:in_progress:${originalTweetId}`;
  const alreadyRunning = await env.AGENT_STATE.get(inProgressKey);
  if (alreadyRunning) {
    console.log(`[agent ${agent.id}] Mention ${originalTweetId} is already in-progress \u2014 skipping`);
    return false; // don't advance cursor
  }
  await env.AGENT_STATE.put(inProgressKey, '1', { expirationTtl: 120 });

  try {
    return await _doProcessMention(
      env, agent, mention, originalTweetId, ownUserId, mediaMap, userMap, botHandles, botUserIds,
    );
  } finally {
    // Always release so errors/early-returns don't block future cron runs.
    await env.AGENT_STATE.delete(inProgressKey);
  }
}

// \u2500\u2500\u2500 Core mention handler (runs inside the in-progress lock) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function _doProcessMention(
  env: Env,
  agent: AgentDbRecord,
  mention: XTweet,
  originalTweetId: string,
  ownUserId: string,
  mediaMap: Map<string, XMedia>,
  userMap: Map<string, string>,
  botHandles: Set<string>,
  botUserIds: Set<string>,
): Promise<boolean> {

  // Convenience wrapper: write the permanent 30-day "replied" marker and return true.
  const permanentSkip = async (reason: string): Promise<true> => {
    console.log(`[agent ${agent.id}] Permanently skipping mention ${mention.id} \u2014 ${reason}`);
    await markReplied(env, agent.id, originalTweetId);
    return true;
  };

  // \u2500\u2500 Bot filter: Layer 0 (user ID) and Layer 1 (handle) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (mention.author_id && botUserIds.has(mention.author_id)) {
    return permanentSkip(`author_id ${mention.author_id} is a known platform bot`);
  }
  const interactorUsername = mention.author_id ? userMap.get(mention.author_id) : undefined;
  if (interactorUsername && botHandles.has(interactorUsername.toLowerCase())) {
    return permanentSkip(`@${interactorUsername} is a known platform bot`);
  }

  console.log(`[agent ${agent.id}] Processing mention ${mention.id} (orig: ${originalTweetId}): "${mention.text.slice(0, 80)}..."`);

  // \u2500\u2500 Fetch conversation thread \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const thread = await fetchThreadContext(env, agent, mention, mediaMap, userMap);
  const conversation = threadToConversation(thread, ownUserId, mediaMap, userMap);
  const agentReplyCount = conversation.filter(t => t.role === 'agent').length;

  // \u2500\u2500 Layer 2: Thread depth limit \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (agentReplyCount >= MAX_THREAD_DEPTH) {
    return permanentSkip(`thread depth limit (${agentReplyCount}/${MAX_THREAD_DEPTH})`);
  }

  // \u2500\u2500 Layer 3: Bystander check \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Twitter auto-injects @agent into every reply within a thread where the agent
  // was mentioned, making bystander comments appear as new summons.
  //
  // We only suppress when the agent has ALREADY replied in this thread
  // (agentReplyCount >= 1). When agentReplyCount === 0, any explicit @mention
  // should be treated as a genuine first-contact \u2014 even if the user is replying
  // to someone else's tweet rather than posting a standalone tweet.
  const isReply = mention.referenced_tweets?.some(r => r.type === 'replied_to') ?? false;
  if (isReply && agentReplyCount >= 1) {
    // thread is ordered oldest\u2192newest; thread[-2] is the tweet that was directly
    // replied to (the parent). If that parent is neither by the agent nor by the
    // person doing the mentioning, it's a bystander sidethread.
    const directParent = thread.length >= 2 ? thread[thread.length - 2] : null;
    const parentIsAgent     = directParent?.author_id === ownUserId;
    const parentIsMentioner = directParent?.author_id === mention.author_id;
    if (!parentIsAgent && !parentIsMentioner) {
      return permanentSkip(
        `bystander sidethread \u2014 parent tweet ${directParent?.id ?? 'none'} ` +
        `is not authored by the agent or the mentioner`
      );
    }
  }

  // \u2500\u2500 Ensure the mention itself is the final user turn \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const last = conversation[conversation.length - 1];
  if (!last || last.role !== 'user') {
    const mediaNote = describeMedia(mention, mediaMap) ?? undefined;
    conversation.push({
      role: 'user',
      text: mention.text,
      authorId: mention.author_id,
      authorUsername: interactorUsername,
      mediaNote,
    });
  }

  // \u2500\u2500 Side-effects: fans + Pro memory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (interactorUsername) await addKnownFan(env, agent.id, interactorUsername);
  if (isAgentPro(env, agent) && interactorUsername && mention.text && shouldAbsorbToMemory(agent, interactorUsername)) {
    await appendInteractionsMemory(env, agent.id, [{
      id: mention.id,
      type: isReply ? 'reply' : 'mention',
      authorUsername: interactorUsername,
      text: mention.text,
      createdAt: mention.created_at ?? new Date().toISOString(),
    }]);
  }

  // \u2500\u2500 LLM decision \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const replyText = await generateReply(env, agent, conversation, ownUserId);

  if (replyText.includes('<skip>') || replyText.trim() === '') {
    await logActivity(env, agent.id, `skip:${originalTweetId}`, 'view',
      `\u5df2\u8bfb\u4e0d\u56de\u4e86 @${interactorUsername} \u7684\u63d0\u53ca\uff1a\u201c${mention.text}\u201d`, interactorUsername);
    return permanentSkip('LLM chose to skip');
  }

  // \u2500\u2500 Post reply & commit the permanent lock \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // markReplied is called AFTER a successful postTweet, not before.
  // This means any API/network error causes the exception to propagate up to
  // runMentionLoop which then unlocks the mention for retry.
  console.log(`[agent ${agent.id}] Posting reply for mention ${mention.id}: "${replyText}"`);
  const posted = await postTweet(env, agent, {
    text: replyText,
    reply: { in_reply_to_tweet_id: mention.id },
  });

  await markReplied(env, agent.id, originalTweetId);
  console.log(`[agent ${agent.id}] Reply posted: ${posted.data.id}`);
  await logActivity(env, agent.id, posted.data.id, 'reply',
    `\u56de\u590d\u4e86 @${interactorUsername}\uff1a\u201c${replyText}\u201d`, interactorUsername);

  return true;
}
// ─── Mention loop (every 1 min) ───────────────────────────────────────────────
export async function runMentionLoop(env: Env, agent: AgentDbRecord): Promise<{ processed: number; error?: string }> {
  const ownUserId = await resolveOwnUserId(env, agent);
  const sinceId = await getLastMentionId(env, agent.id);

  console.log(`[agent ${agent.id}] Polling mentions since_id=${sinceId ?? 'none'}`);

  const response = await getMentions(env, agent, ownUserId, sinceId ?? undefined);

  if (!response.data || response.data.length === 0) {
    console.log(`[agent ${agent.id}] No new mentions.`);
    return { processed: 0 };
  }

  const mediaMap = buildMediaMap(response.includes);
  const userMap = buildUserMap(response.includes);

  // Load known bot handles AND user IDs once per run (two-layer loop prevention)
  const [botHandles, botUserIds] = await Promise.all([
    getKnownBotHandles(env),
    getKnownBotUserIds(env),
  ]);
  // Exclude self from both sets so the agent doesn't skip its own continued threads
  botHandles.delete((agent.agent_handle ?? '').toLowerCase());
  botUserIds.delete(ownUserId);

  // X returns newest-first; process oldest-first so IDs advance monotonically
  const allMentions = [...response.data].reverse().slice(0, MAX_PROCESS_PER_RUN);

  // ── Deduplicate by conversation_id ─────────────────────────────────────────
  // In a multi-person discussion thread, multiple participants may @mention the
  // agent in the same conversation. We should only respond ONCE per thread to
  // avoid spamming similar replies. Keep only the newest mention per conversation
  // (after reverse(), the last entry per conversation_id is the most recent).
  const seenConversations = new Map<string, XTweet>(); // conversation_id → mention
  for (const mention of allMentions) {
    const convId = mention.conversation_id ?? mention.id;
    seenConversations.set(convId, mention); // later entries overwrite → newest wins
  }
  const mentions = [...seenConversations.values()];

  // Mark any mention that was deduplicated-away as already replied to,
  // so they don't get picked up in future runs either.
  for (const mention of allMentions) {
    const convId = mention.conversation_id ?? mention.id;
    const chosen = seenConversations.get(convId);
    if (chosen && chosen.id !== mention.id) {
      const originalId = mention.edit_history_tweet_ids?.[0] ?? mention.id;
      const alreadyLocked = await hasReplied(env, agent.id, originalId);
      if (!alreadyLocked) {
        await markReplied(env, agent.id, originalId);
        console.log(`[agent ${agent.id}] Deduped mention ${originalId} (same conv ${convId} as chosen ${chosen.id}) — marked as handled`);
      }
    }
  }

  let processed = 0;
  let latestSuccessId = sinceId;
  let lastError: string | undefined = undefined;

  for (const mention of mentions) {
    if (mention.author_id === ownUserId) {
      latestSuccessId = mention.id;
      continue;
    }

    let success = false;
    try {
      success = await processMention(env, agent, mention, ownUserId, mediaMap, userMap, botHandles, botUserIds);
      if (success) processed++;
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('failed 403') || errStr.includes('You are not permitted')) {
        console.warn(`[agent ${agent.id}] Un-replyable mention ${mention.id} (403). Skipping permanently.`);
        success = true;
      } else {
        console.error(`[agent ${agent.id}] Failed to process mention ${mention.id}:`, err);
        const originalIdForUnlock = mention.edit_history_tweet_ids?.[0] ?? mention.id;
        await env.AGENT_STATE.delete(`agent:${agent.id}:replied:${originalIdForUnlock}`);
        lastError = errStr;
      }
    }

    if (success) {
      latestSuccessId = mention.id;
    } else {
      console.warn(`[agent ${agent.id}] Stopping cursor advancement at mention ${mention.id} due to failure`);
      break;
    }
  }

  // Advance cursor to the highest ID among ALL allMentions entries that we've
  // successfully handled (either by processing or by dedup-marking). This ensures
  // deduplicated mentions don't resurface in the next polling run.
  if (lastError === undefined) {
    // No errors — all allMentions were handled; find the highest ID.
    const maxId = allMentions.reduce((best, m) => {
      // Compare snowflake IDs lexicographically (they're monotonically increasing)
      return m.id > best ? m.id : best;
    }, sinceId ?? '');
    if (maxId && maxId !== sinceId) {
      latestSuccessId = maxId;
    }
  }

  if (latestSuccessId && latestSuccessId !== sinceId) {
    await saveLastMentionId(env, agent.id, latestSuccessId);
    console.log(`[agent ${agent.id}] Cursor advanced to ${latestSuccessId}`);
  }

  return { processed, error: lastError };
}

// ─── Spontaneous tweet loop ──────────────────────────────────────────────────
export async function runSpontaneousTweet(
  env: Env,
  agent: AgentDbRecord,
  forceCooldownBypass = false,
): Promise<{ tweetId: string; text: string } | { skipped: true; reason: string }> {
  if (!forceCooldownBypass) {
    const lastTime = await getLastSpontaneous(env, agent.id);
    if (lastTime) {
      const cooldownMinutes = agent.cooldown_days * 24 * 60;
      const minutesSince = (Date.now() - lastTime.getTime()) / 60_000;
      if (minutesSince < cooldownMinutes) {
        const waitMins = Math.ceil(cooldownMinutes - minutesSince);
        const waitHours = (waitMins / 60).toFixed(1);
        console.log(`[agent ${agent.id}] Spontaneous tweet skipped — cooldown (${waitHours} hours remaining)`);
        return { skipped: true, reason: `Cooldown active: wait ${waitHours} more hours` };
      }
    }
  }

  console.log(`[agent ${agent.id}] Generating spontaneous tweet...`);
  const recentPosts = await getRecentSpontaneous(env, agent.id);
  const text = await generateSpontaneousTweet(env, agent, recentPosts);
  console.log(`[agent ${agent.id}] Spontaneous tweet: "${text}"`);

  const posted = await postTweet(env, agent, { text });
  console.log(`[agent ${agent.id}] Spontaneous tweet posted: ${posted.data.id}`);

  await saveLastSpontaneous(env, agent.id);
  await appendRecentSpontaneous(env, agent.id, text);
  await logActivity(env, agent.id, posted.data.id, 'post', `自发了一条推文："${text}"`);

  return { tweetId: posted.data.id, text: posted.data.text };
}

// ─── Timeline engagement loop (every N hours) ─────────────────────────────────
export async function runTimelineEngagement(env: Env, agent: AgentDbRecord): Promise<{ evaluated: number; likes: number; replies: number; debug?: unknown }> {
  console.log(`[agent ${agent.id}] Starting timeline engagement...`);

  const ownUserId = await resolveOwnUserId(env, agent);

  // Build the stalk list: known fans first, fall back to VIP usernames
  let fansToStalk = await getKnownFans(env, agent.id);
  if (fansToStalk.length === 0) {
    fansToStalk = agent.vip_list.map(v => v.username);
  }

  // Randomize and take up to 3
  fansToStalk = fansToStalk.sort(() => 0.5 - Math.random()).slice(0, 3);

  const following = [];
  for (const username of fansToStalk) {
    const user = await getUserByUsername(env, agent, username);
    if (user) following.push(user);
  }

  if (following.length === 0) {
    console.log(`[agent ${agent.id}] Timeline engagement skipped: Could not resolve any users.`);
    return { evaluated: 0, likes: 0, replies: 0, debug: { reason: 'Failed to resolve any users from fan/VIP list' } };
  }

  const shuffledFollowing = [...following].sort(() => 0.5 - Math.random()).slice(0, 3);
  let allTweets: Array<{ user: { username: string; id: string }; tweet: XTweet }> = [];

  for (const f of shuffledFollowing) {
    const tweets = await getUserTweets(env, agent, f.id, 5);
    for (const t of tweets) {
      if (!t.referenced_tweets?.some(r => r.type === 'replied_to')) {
        allTweets.push({ user: f, tweet: t });
      }
    }
  }

  const unseen = [];
  for (const item of allTweets) {
    const seen = await hasSeenTimelineTweet(env, agent.id, item.tweet.id);
    if (!seen) unseen.push(item);
  }

  if (unseen.length === 0) {
    return { evaluated: 0, likes: 0, replies: 0, debug: { reason: 'No new unseen tweets', fetched: allTweets.length } };
  }

  const toEvaluate = [...unseen].sort(() => 0.5 - Math.random()).slice(0, 2);

  let likes = 0;
  let replies = 0;

  // ── Layer 0+1: Skip if the tweet author is a known platform bot ─────────────
  // Layer 0: immutable user ID check; Layer 1: handle-based fallback
  const [botHandles, botUserIds] = await Promise.all([
    getKnownBotHandles(env),
    getKnownBotUserIds(env),
  ]);
  botHandles.delete((agent.agent_handle ?? '').toLowerCase());
  botUserIds.delete(ownUserId);

  for (const item of toEvaluate) {
    const authorHandle = item.user.username.toLowerCase();
    const isBotByUserId = botUserIds.has(item.user.id);
    const isBotByHandle = botHandles.has(authorHandle);
    if (isBotByUserId || isBotByHandle) {
      console.log(`[agent ${agent.id}] Skipping timeline tweet ${item.tweet.id} — author @${item.user.username} is a known platform bot`);
      await markTimelineTweetSeen(env, agent.id, item.tweet.id);
      continue;
    }
    console.log(`[agent ${agent.id}] Evaluating timeline tweet ${item.tweet.id} from @${item.user.username}...`);
    await markTimelineTweetSeen(env, agent.id, item.tweet.id);

    try {
      const tweetReplies = await getTweetReplies(env, agent, item.tweet, 3);
      const decision = await evaluateTimelineTweet(env, agent, item.tweet.text, item.user.username, tweetReplies);
      console.log(`[agent ${agent.id}] LLM decision for ${item.tweet.id}: "${decision}"`);

      if (decision.startsWith('<skip>')) {
        await logActivity(env, agent.id, `skip:${item.tweet.id}`, 'view', `默默看了看 @${item.user.username} 说的："${item.tweet.text}"`, item.user.username);
      } else if (decision.startsWith('<like>')) {
        await likeTweet(env, agent, ownUserId, item.tweet.id);
        await logActivity(env, agent.id, `like:${item.tweet.id}`, 'like', `给 @${item.user.username} 点了个赞："${item.tweet.text}"`, item.user.username);
        likes++;
      } else {
        const posted = await postTweet(env, agent, {
          text: decision,
          reply: { in_reply_to_tweet_id: item.tweet.id },
        });
        await likeTweet(env, agent, ownUserId, item.tweet.id);
        await logActivity(env, agent.id, posted.data.id, 'reply', `在时间线主动回复了 @${item.user.username}："${decision}"`, item.user.username);
        replies++;
      }
    } catch (err) {
      console.error(`[agent ${agent.id}] Failed to engage with tweet ${item.tweet.id}:`, err);
    }
  }

  console.log(`[agent ${agent.id}] Timeline sweep done. Evaluated ${toEvaluate.length}, Likes ${likes}, Replies ${replies}.`);
  return { evaluated: toEvaluate.length, likes, replies };
}

// ─── Interaction Memory Refresh (Pro only) ─────────────────────────────────
export async function runMemoryRefresh(env: Env, agent: AgentDbRecord): Promise<{ added: number; error?: string }> {
  if (!isAgentPro(env, agent)) {
    console.log(`[agent ${agent.id}] Memory refresh skipped — Pro license not active.`);
    return { added: 0, error: 'pro_required' };
  }
  try {
    const ownUserId = await resolveOwnUserId(env, agent);
    console.log(`[agent ${agent.id}] Running memory refresh...`);

    const response = await getMentions(env, agent, ownUserId, undefined, 100);
    if (!response.data || response.data.length === 0) return { added: 0 };

    const userMap = buildUserMap(response.includes);

    const newItems: InteractionMemory[] = [];
    for (const mention of response.data) {
      if (mention.author_id === ownUserId) continue;

      const username = mention.author_id ? userMap.get(mention.author_id) : undefined;
      if (username && mention.text && shouldAbsorbToMemory(agent, username)) {
        newItems.push({
          id: mention.id,
          type: mention.referenced_tweets?.some(t => t.type === 'replied_to') ? 'reply' : 'mention',
          authorUsername: username,
          text: mention.text,
          createdAt: mention.created_at ?? new Date().toISOString(),
        });
      }
    }

    if (newItems.length > 0) {
      await appendInteractionsMemory(env, agent.id, newItems);
    }

    return { added: newItems.length };
  } catch (e) {
    console.error(`[agent ${agent.id}] runMemoryRefresh error:`, e);
    return { added: 0, error: String(e) };
  }
}

// ─── Nightly Evolution (Personality Rewrite, Pro only) ─────────────────────────
export async function runNightlyEvolution(env: Env, agent: AgentDbRecord): Promise<{ evolved: boolean; previousLength?: number; newLength?: number; info?: string }> {
  if (!isAgentPro(env, agent)) {
    console.log(`[agent ${agent.id}] Nightly evolution skipped — Pro license not active.`);
    return { evolved: false, info: 'pro_required' };
  }
  if (!agent.auto_evo) {
    return { evolved: false, info: 'Nightly evolution is disabled in config' };
  }

  try {
    console.log(`[agent ${agent.id}] Starting nightly evolution protocol...`);

    const memories = await getInteractionsMemory(env, agent.id);
    if (memories.length === 0) {
      console.log(`[agent ${agent.id}] No new interactions memory to evolve from.`);
      return { evolved: false, info: 'No memories to digest' };
    }

    const currentSkill = agent.skill_text;

    console.log(`[agent ${agent.id}] Evolving personality using ${memories.length} historical records...`);
    const newSkill = await evolvePersonalitySkill(env, agent, currentSkill, memories);

    if (!newSkill || newSkill.trim() === '') {
      throw new Error('Evolved skill was empty.');
    }

    await env.DB.prepare('UPDATE agents SET skill_text = ? WHERE id = ?')
      .bind(newSkill, agent.id)
      .run();
    agent.skill_text = newSkill;

    await clearInteractionsMemory(env, agent.id);

    console.log(`[agent ${agent.id}] Personality successfully evolved. Memory buffer cleared.`);

    await logActivity(
      env,
      agent.id,
      `evolve:${Date.now()}`,
      'post',
      `进行了深度冥想，吸收了 ${memories.length} 条记忆碎片，人格基座发生了微弱的演化。`
    );

    return {
      evolved: true,
      previousLength: currentSkill.length,
      newLength: newSkill.length,
    };
  } catch (e) {
    console.error(`[agent ${agent.id}] runNightlyEvolution error:`, e);
    return { evolved: false, info: 'Error: ' + String(e) };
  }
}

// ─── Refresh Source Account Display Names (Daily) ────────────────────────────
/**
 * Fetches the current display name for each source account via the Twitter API
 * and caches the { username → name } map in KV for the dashboard to consume.
 * Runs once per day; gracefully skips accounts that fail to resolve.
 */
export async function runRefreshSourceNames(
  env: Env,
  agent: AgentDbRecord,
): Promise<{ updated: number; failed: number }> {
  const usernames = agent.source_accounts;
  if (usernames.length === 0) {
    console.log(`[agent ${agent.id}] No source accounts to refresh names for.`);
    return { updated: 0, failed: 0 };
  }

  console.log(`[agent ${agent.id}] Refreshing display names for ${usernames.length} source account(s): ${usernames.join(', ')}`);

  // Load existing cache so we can merge partial results
  const existing = await getSourceNames(env, agent.id);
  const updated = { ...existing };
  let successCount = 0;
  let failCount = 0;

  for (const username of usernames) {
    try {
      const user = await getUserByUsername(env, agent, username);
      if (user) {
        updated[user.username] = user.name;
        successCount++;
        console.log(`[agent ${agent.id}] Source @${user.username} → "${user.name}"`);
      } else {
        console.warn(`[agent ${agent.id}] Could not resolve @${username}`);
        failCount++;
      }
    } catch (err) {
      console.warn(`[agent ${agent.id}] Error fetching display name for @${username}:`, err);
      failCount++;
    }
  }

  await saveSourceNames(env, agent.id, updated);
  console.log(`[agent ${agent.id}] Source name refresh done. Updated: ${successCount}, Failed: ${failCount}.`);

  return { updated: successCount, failed: failCount };
}
