import type { Env, ConversationTurn, XMedia, XTweet, InteractionMemory } from './types.ts';
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
  getSkill,
  saveSkill,
  getInteractionsMemory,
  clearInteractionsMemory,
} from './memory.ts';
import { agentConfig } from './config.ts';

// Max mentions to process in a single cron run
const MAX_PROCESS_PER_RUN = 5;

// ─── Resolve own user ID (cached in KV) ───────────────────────────────────────
async function resolveOwnUserId(env: Env): Promise<string> {
  const cached = await getCachedOwnUserId(env);
  if (cached) return cached;

  const me = await getMe(env);
  await saveOwnUserId(env, me.id);
  console.log(`[agent] Own user ID resolved: @${me.username} (${me.id})`);
  return me.id;
}

// ─── Resolve a source account's user ID (cached in KV) ───────────────────────
async function resolveSourceUserId(env: Env, username: string): Promise<string | null> {
  const cached = await getCachedSourceUserId(env, username);
  if (cached) return cached;

  const user = await getUserByUsername(env, username);
  if (!user) {
    console.warn(`[agent] Could not resolve user ID for @${username}`);
    return null;
  }

  await saveSourceUserId(env, username, user.id);
  console.log(`[agent] Source account @${username} resolved: ${user.id}`);
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
function shouldAbsorbToMemory(username: string): boolean {
  const whitelist = agentConfig.memoryWhitelist;
  if (whitelist === 'all') return true;
  return whitelist.includes(username);
}

// ─── Process a single mention ─────────────────────────────────────────────────
async function processMention(
  env: Env,
  mention: XTweet,
  ownUserId: string,
  mediaMap: Map<string, XMedia>,
  userMap: Map<string, string>,
): Promise<boolean> {
  const originalTweetId = mention.edit_history_tweet_ids?.[0] ?? mention.id;

  if (await hasReplied(env, originalTweetId)) {
    console.log(`[agent] Skipping mention ${originalTweetId} — already replied or locked`);
    return true;
  }

  // Pre-acquire lock to prevent concurrent runs
  await markReplied(env, originalTweetId);

  console.log(`[agent] Processing mention ${mention.id} (orig: ${originalTweetId}): "${mention.text.slice(0, 60)}..."`);

  const thread = await fetchThreadContext(
    env,
    mention as Parameters<typeof fetchThreadContext>[1],
    mediaMap,
    userMap,
  );

  const conversation = threadToConversation(thread, ownUserId, mediaMap, userMap);

  const last = conversation[conversation.length - 1];
  if (!last || last.role !== 'user') {
    const mediaNote = describeMedia(mention as Parameters<typeof describeMedia>[0], mediaMap) ?? undefined;
    const authorUsername = mention.author_id ? userMap.get(mention.author_id) : undefined;
    conversation.push({ role: 'user', text: mention.text, authorId: mention.author_id, authorUsername, mediaNote });
  }

  const interactorUsername = mention.author_id ? userMap.get(mention.author_id) : undefined;

  // Register to known fans for timeline stalking
  if (interactorUsername) {
    await addKnownFan(env, interactorUsername);
  }

  // Absorb to memory if on whitelist
  if (interactorUsername && mention.text && shouldAbsorbToMemory(interactorUsername)) {
    await appendInteractionsMemory(env, [{
      id: mention.id,
      type: mention.referenced_tweets?.some(t => t.type === 'replied_to') ? 'reply' : 'mention',
      authorUsername: interactorUsername,
      text: mention.text,
      createdAt: mention.created_at ?? new Date().toISOString(),
    }]);
  }

  const replyText = await generateReply(env, conversation, ownUserId);

  if (replyText.includes('<skip>') || replyText.trim() === '') {
    console.log(`[agent] LLM chose to silently skip mention ${mention.id}`);
    await logActivity(env, `skip:${originalTweetId}`, 'view', `已读不回了 @${interactorUsername} 的提及："${mention.text}"`, interactorUsername);
    return true;
  }

  console.log(`[agent] Generated reply for ${mention.id}: "${replyText}"`);

  const posted = await postTweet(env, {
    text: replyText,
    reply: { in_reply_to_tweet_id: originalTweetId },
  });

  console.log(`[agent] Reply posted: ${posted.data.id}`);
  await logActivity(env, posted.data.id, 'reply', `回复了 @${interactorUsername}："${replyText}"`, interactorUsername);

  return true;
}

// ─── Mention loop (every 1 min) ───────────────────────────────────────────────
export async function runMentionLoop(env: Env): Promise<{ processed: number; error?: string }> {
  const ownUserId = await resolveOwnUserId(env);
  const sinceId = await getLastMentionId(env);

  console.log(`[agent] Polling mentions since_id=${sinceId ?? 'none'}`);

  const response = await getMentions(env, ownUserId, sinceId ?? undefined);

  if (!response.data || response.data.length === 0) {
    console.log('[agent] No new mentions.');
    return { processed: 0 };
  }

  const mediaMap = buildMediaMap(response.includes);
  const userMap = buildUserMap(response.includes);

  // X returns newest-first; process oldest-first so IDs advance monotonically
  const mentions = [...response.data].reverse().slice(0, MAX_PROCESS_PER_RUN);

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
      success = await processMention(env, mention, ownUserId, mediaMap, userMap);
      if (success) processed++;
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('failed 403') || errStr.includes('You are not permitted')) {
        console.warn(`[agent] Un-replyable mention ${mention.id} (403). Skipping permanently.`);
        success = true;
      } else {
        console.error(`[agent] Failed to process mention ${mention.id}:`, err);
        const originalIdForUnlock = mention.edit_history_tweet_ids?.[0] ?? mention.id;
        await env.AGENT_STATE.delete(`replied:${originalIdForUnlock}`);
        lastError = errStr;
      }
    }

    if (success) {
      latestSuccessId = mention.id;
    } else {
      console.warn(`[agent] Stopping cursor advancement at mention ${mention.id} due to failure`);
      break;
    }
  }

  if (latestSuccessId && latestSuccessId !== sinceId) {
    await saveLastMentionId(env, latestSuccessId);
    console.log(`[agent] Cursor advanced to ${latestSuccessId}`);
  }

  return { processed, error: lastError };
}

// ─── Spontaneous tweet loop ──────────────────────────────────────────────────
export async function runSpontaneousTweet(
  env: Env,
  forceCooldownBypass = false,
): Promise<{ tweetId: string; text: string } | { skipped: true; reason: string }> {
  if (!forceCooldownBypass) {
    const lastTime = await getLastSpontaneous(env);
    if (lastTime) {
      const cooldownMinutes = agentConfig.spontaneousCooldownDays * 24 * 60;
      const minutesSince = (Date.now() - lastTime.getTime()) / 60_000;
      if (minutesSince < cooldownMinutes) {
        const waitMins = Math.ceil(cooldownMinutes - minutesSince);
        const waitHours = (waitMins / 60).toFixed(1);
        console.log(`[agent] Spontaneous tweet skipped — cooldown (${waitHours} hours remaining)`);
        return { skipped: true, reason: `Cooldown active: wait ${waitHours} more hours` };
      }
    }
  }

  console.log('[agent] Generating spontaneous tweet...');
  const recentPosts = await getRecentSpontaneous(env);
  const text = await generateSpontaneousTweet(env, recentPosts);
  console.log(`[agent] Spontaneous tweet: "${text}"`);

  const posted = await postTweet(env, { text });
  console.log(`[agent] Spontaneous tweet posted: ${posted.data.id}`);

  await saveLastSpontaneous(env);
  await appendRecentSpontaneous(env, text);
  await logActivity(env, posted.data.id, 'post', `自发了一条推文："${text}"`);

  return { tweetId: posted.data.id, text: posted.data.text };
}

// ─── Timeline engagement loop (every N hours) ─────────────────────────────────
export async function runTimelineEngagement(env: Env): Promise<{ evaluated: number; likes: number; replies: number; debug?: unknown }> {
  console.log('[agent] Starting timeline engagement...');

  const ownUserId = await resolveOwnUserId(env);

  // Build the stalk list: known fans first, fall back to VIP usernames
  let fansToStalk = await getKnownFans(env);
  if (fansToStalk.length === 0) {
    fansToStalk = agentConfig.vipList.map(v => v.username);
  }

  // Randomize and take up to 3
  fansToStalk = fansToStalk.sort(() => 0.5 - Math.random()).slice(0, 3);

  const following = [];
  for (const username of fansToStalk) {
    const user = await getUserByUsername(env, username);
    if (user) following.push(user);
  }

  if (following.length === 0) {
    console.log('[agent] Timeline engagement skipped: Could not resolve any users.');
    return { evaluated: 0, likes: 0, replies: 0, debug: { reason: 'Failed to resolve any users from fan/VIP list' } };
  }

  const shuffledFollowing = [...following].sort(() => 0.5 - Math.random()).slice(0, 3);
  let allTweets: Array<{ user: { username: string; id: string }; tweet: XTweet }> = [];

  for (const f of shuffledFollowing) {
    const tweets = await getUserTweets(env, f.id, 5);
    for (const t of tweets) {
      if (!t.referenced_tweets?.some(r => r.type === 'replied_to')) {
        allTweets.push({ user: f, tweet: t });
      }
    }
  }

  const unseen = [];
  for (const item of allTweets) {
    const seen = await hasSeenTimelineTweet(env, item.tweet.id);
    if (!seen) unseen.push(item);
  }

  if (unseen.length === 0) {
    return { evaluated: 0, likes: 0, replies: 0, debug: { reason: 'No new unseen tweets', fetched: allTweets.length } };
  }

  const toEvaluate = [...unseen].sort(() => 0.5 - Math.random()).slice(0, 2);

  let likes = 0;
  let replies = 0;

  for (const item of toEvaluate) {
    console.log(`[agent] Evaluating timeline tweet ${item.tweet.id} from @${item.user.username}...`);
    await markTimelineTweetSeen(env, item.tweet.id);

    try {
      const tweetReplies = await getTweetReplies(env, item.tweet, 3);
      const decision = await evaluateTimelineTweet(env, item.tweet.text, item.user.username, tweetReplies);
      console.log(`[agent] LLM decision for ${item.tweet.id}: "${decision}"`);

      if (decision === '<skip>') {
        await logActivity(env, `skip:${item.tweet.id}`, 'view', `默默看了看 @${item.user.username} 说的："${item.tweet.text}"`, item.user.username);
      } else if (decision === '<like>') {
        await likeTweet(env, ownUserId, item.tweet.id);
        await logActivity(env, `like:${item.tweet.id}`, 'like', `给 @${item.user.username} 点了个赞："${item.tweet.text}"`, item.user.username);
        likes++;
      } else {
        const posted = await postTweet(env, {
          text: decision,
          reply: { in_reply_to_tweet_id: item.tweet.id },
        });
        await likeTweet(env, ownUserId, item.tweet.id);
        await logActivity(env, posted.data.id, 'reply', `在时间线主动回复了 @${item.user.username}："${decision}"`, item.user.username);
        replies++;
      }
    } catch (err) {
      console.error(`[agent] Failed to engage with tweet ${item.tweet.id}:`, err);
    }
  }

  console.log(`[agent] Timeline sweep done. Evaluated ${toEvaluate.length}, Likes ${likes}, Replies ${replies}.`);
  return { evaluated: toEvaluate.length, likes, replies };
}

// ─── Interaction Memory Refresh ──────────────────────────────────────────────
export async function runMemoryRefresh(env: Env): Promise<{ added: number; error?: string }> {
  try {
    const ownUserId = await resolveOwnUserId(env);
    console.log('[agent] Running memory refresh...');

    const response = await getMentions(env, ownUserId, undefined, 100);
    if (!response.data || response.data.length === 0) return { added: 0 };

    const userMap = buildUserMap(response.includes);

    const newItems: InteractionMemory[] = [];
    for (const mention of response.data) {
      if (mention.author_id === ownUserId) continue;

      const username = mention.author_id ? userMap.get(mention.author_id) : undefined;
      if (username && mention.text && shouldAbsorbToMemory(username)) {
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
      await appendInteractionsMemory(env, newItems);
    }

    return { added: newItems.length };
  } catch (e) {
    console.error('[agent] runMemoryRefresh error:', e);
    return { added: 0, error: String(e) };
  }
}

// ─── Nightly Evolution (Personality Rewrite) ──────────────────────────────────
export async function runNightlyEvolution(env: Env): Promise<{ evolved: boolean; previousLength?: number; newLength?: number; info?: string }> {
  if (!agentConfig.enableNightlyEvolution) {
    return { evolved: false, info: 'Nightly evolution is disabled in config' };
  }

  try {
    console.log('[agent] Starting nightly evolution protocol...');

    const memories = await getInteractionsMemory(env);
    if (memories.length === 0) {
      console.log('[agent] No new interactions memory to evolve from.');
      return { evolved: false, info: 'No memories to digest' };
    }

    const currentSkill = await getSkill(env);

    console.log(`[agent] Evolving personality using ${memories.length} historical records...`);
    const newSkill = await evolvePersonalitySkill(env, currentSkill, memories);

    if (!newSkill || newSkill.trim() === '') {
      throw new Error('Evolved skill was empty.');
    }

    await saveSkill(env, newSkill);
    await clearInteractionsMemory(env);

    console.log('[agent] Personality successfully evolved. Memory buffer cleared.');

    await logActivity(
      env,
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
    console.error('[agent] runNightlyEvolution error:', e);
    return { evolved: false, info: 'Error: ' + String(e) };
  }
}
