import type { AgentDbRecord, 
  Env,
  TweetPayload,
  TweetResponse,
  XMentionsResponse,
  XTweet,
  XMedia,
  XTweetLookupResponse,
} from './types.ts';
import { getValidAccessToken } from './auth.ts';

const API_BASE = 'https://api.twitter.com/2';

// Tweet fields requested on every call — includes attachments for media awareness
const TWEET_FIELDS = 'conversation_id,referenced_tweets,author_id,created_at,text,attachments';
const EXPANSIONS = 'referenced_tweets.id,author_id,attachments.media_keys';
const MEDIA_FIELDS = 'media_key,type,url,preview_image_url';

// ─── Core request helper ───────────────────────────────────────────────────────
export async function xFetch(
  env: Env, agent: AgentDbRecord,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const accessToken = await getValidAccessToken(env, agent);

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'twitter-agent-worker/1.0',
      ...(options.headers ?? {}),
    },
  });

  const remaining = res.headers.get('x-rate-limit-remaining');
  const resetAt = res.headers.get('x-rate-limit-reset');
  if (remaining !== null) {
    console.log(`[twitter] Rate limit remaining: ${remaining}, resets at: ${resetAt}`);
  }

  return res;
}

// ─── Build lookup maps from includes ──────────────────────────────────────────

export function buildMediaMap(includes?: XMentionsResponse['includes']) {
  const map = new Map<string, XMedia>();
  if (includes?.media) {
    for (const m of includes.media) {
      map.set(m.media_key, m);
    }
  }
  return map;
}

export function buildUserMap(includes?: XMentionsResponse['includes']) {
  const map = new Map<string, string>(); // author_id → username
  if (includes?.users) {
    for (const u of includes.users) {
      map.set(u.id, u.username);
    }
  }
  return map;
}

// ─── Describe media from a tweet for LLM context ──────────────────────────────
export function describeMedia(tweet: XTweet, mediaMap: Map<string, XMedia>): string | null {
  const keys = tweet.attachments?.media_keys;
  if (!keys || keys.length === 0) return null;

  const descs = keys.map(key => {
    const m = mediaMap.get(key);
    if (!m) return '附件';
    if (m.type === 'photo') return `[图片${m.url ? ': ' + m.url : ''}]`;
    if (m.type === 'video') return '[视频]';
    if (m.type === 'animated_gif') return '[GIF]';
    return '[媒体]';
  });

  return descs.join(' ');
}

// ─── Get own user info ─────────────────────────────────────────────────────────
export async function getMe(env: Env, agent: AgentDbRecord): Promise<{ id: string; name: string; username: string }> {
  const res = await xFetch(env, agent, '/users/me');
  if (!res.ok) throw new Error(`[twitter] GET /users/me failed ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { id: string; name: string; username: string } };
  return json.data;
}

// ─── Get recent mentions ───────────────────────────────────────────────────────
export async function getMentions(
  env: Env, agent: AgentDbRecord,
  userId: string,
  sinceId?: string,
  maxResults = 10,
): Promise<XMentionsResponse> {
  const params = new URLSearchParams({
    max_results: String(maxResults),
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'media.fields': MEDIA_FIELDS,
  });

  if (sinceId) {
    params.set('since_id', sinceId);
  }

  const res = await xFetch(env, agent, `/users/${userId}/mentions?${params}`);

  if (res.status === 404 || res.status === 401) {
    throw new Error(`[twitter] GET mentions failed ${res.status}: ${await res.text()}`);
  }
  if (!res.ok) {
    const body = await res.text();
    console.warn(`[twitter] mentions non-ok ${res.status}: ${body}`);
    return {};
  }

  return res.json() as Promise<XMentionsResponse>;
}

// ─── Fetch a single tweet by ID ────────────────────────────────────────────────
export async function getTweetLookup(env: Env, agent: AgentDbRecord, tweetId: string): Promise<XTweetLookupResponse | null> {
  const params = new URLSearchParams({
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'media.fields': MEDIA_FIELDS,
  });

  const res = await xFetch(env, agent, `/tweets/${tweetId}?${params}`);
  if (!res.ok) {
    console.warn(`[twitter] GET /tweets/${tweetId} failed ${res.status}`);
    return null;
  }

  return res.json() as Promise<XTweetLookupResponse>;
}

export async function getTweet(env: Env, agent: AgentDbRecord, tweetId: string): Promise<XTweet | null> {
  const json = await getTweetLookup(env, agent, tweetId);
  return json?.data ?? null;
}

// ─── Build conversation thread by walking up referenced_tweets ─────────────────
// Returns tweets from oldest to newest.
export async function fetchThreadContext(
  env: Env, agent: AgentDbRecord,
  mention: XTweet,
  mediaMap: Map<string, XMedia>,
  userMap: Map<string, string>,
  maxDepth = 6,
): Promise<XTweet[]> {
  const chain: XTweet[] = [mention];
  let current = mention;

  for (let depth = 0; depth < maxDepth; depth++) {
    const parentRef = current.referenced_tweets?.find(r => r.type === 'replied_to');
    if (!parentRef) break;

    const parentLookup = await getTweetLookup(env, agent, parentRef.id);
    if (!parentLookup?.data) break;

    const parent = parentLookup.data;
    if (parentLookup.includes?.media) {
      for (const m of parentLookup.includes.media) mediaMap.set(m.media_key, m);
    }
    if (parentLookup.includes?.users) {
      for (const u of parentLookup.includes.users) userMap.set(u.id, u.username);
    }

    chain.unshift(parent);
    current = parent;
  }

  return chain;
}

// ─── Post a tweet (or reply) ───────────────────────────────────────────────────
export async function postTweet(env: Env, agent: AgentDbRecord, payload: TweetPayload): Promise<TweetResponse> {
  const res = await xFetch(env, agent, '/tweets', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`[twitter] POST /tweets failed ${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<TweetResponse>;
}

// ─── Look up a user by username ────────────────────────────────────────────────
export async function getUserByUsername(
  env: Env, agent: AgentDbRecord,
  username: string,
): Promise<{ id: string; name: string; username: string } | null> {
  const res = await xFetch(env, agent, `/users/by/username/${username}`);

  if (!res.ok) {
    console.warn(`[twitter] GET /users/by/username/${username} failed ${res.status}`);
    return null;
  }

  const json = (await res.json()) as { data: { id: string; name: string; username: string } };
  return json.data ?? null;
}

// ─── Get recent tweets from a user ────────────────────────────────────────────
export async function getUserTweets(
  env: Env, agent: AgentDbRecord,
  userId: string,
  maxResults = 20,
): Promise<XTweet[]> {
  const params = new URLSearchParams({
    max_results: String(Math.min(maxResults, 100)),
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'media.fields': MEDIA_FIELDS,
    exclude: 'retweets',
  });

  const res = await xFetch(env, agent, `/users/${userId}/tweets?${params}`);

  if (!res.ok) {
    console.warn(`[twitter] GET /users/${userId}/tweets failed ${res.status}`);
    return [];
  }

  const json = (await res.json()) as { data?: XTweet[] };
  return json.data ?? [];
}

// ─── Get the accounts the user follows ────────────────────────────────────────
export async function getFollowing(
  env: Env, agent: AgentDbRecord,
  userId: string,
  maxResults = 100,
): Promise<{ id: string; name: string; username: string }[]> {
  const params = new URLSearchParams({
    max_results: String(maxResults),
  });

  const res = await xFetch(env, agent, `/users/${userId}/following?${params}`);
  if (!res.ok) {
    const errorBody = await res.text();
    console.warn(`[twitter] GET /users/${userId}/following failed ${res.status}: ${errorBody}`);
    return [];
  }

  const json = (await res.json()) as { data?: { id: string; name: string; username: string }[] };
  return json.data ?? [];
}

// ─── Like a tweet ──────────────────────────────────────────────────────────────
export async function likeTweet(
  env: Env, agent: AgentDbRecord,
  userId: string,
  tweetId: string,
): Promise<boolean> {
  const res = await xFetch(env, agent, `/users/${userId}/likes`, {
    method: 'POST',
    body: JSON.stringify({ tweet_id: tweetId }),
  });

  if (!res.ok) {
    console.warn(`[twitter] POST /users/${userId}/likes failed ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

// ─── Follow a user ─────────────────────────────────────────────────────────────
export async function followUser(
  env: Env, agent: AgentDbRecord,
  userId: string,
  targetUserId: string,
): Promise<boolean> {
  const res = await xFetch(env, agent, `/users/${userId}/following`, {
    method: 'POST',
    body: JSON.stringify({ target_user_id: targetUserId }),
  });

  if (!res.ok) {
    console.warn(`[twitter] POST /users/${userId}/following failed ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

// ─── Fetch top replies to a tweet via conversation search ──────────────────────
export async function getTweetReplies(
  env: Env, agent: AgentDbRecord,
  tweet: XTweet,
  maxResults = 3,
): Promise<Array<{ authorUsername: string; text: string }>> {
  const conversationId = tweet.conversation_id ?? tweet.id;

  const params = new URLSearchParams({
    query: `conversation_id:${conversationId} is:reply`,
    max_results: String(Math.min(maxResults, 10)),
    'tweet.fields': 'author_id,text',
    expansions: 'author_id',
    'user.fields': 'username',
  });

  try {
    const res = await xFetch(env, agent, `/tweets/search/recent?${params}`);
    if (!res.ok) {
      console.warn(`[twitter] getTweetReplies failed ${res.status} for conversation ${conversationId}`);
      return [];
    }

    const json = (await res.json()) as {
      data?: XTweet[];
      includes?: { users?: Array<{ id: string; username: string }> };
    };

    if (!json.data || json.data.length === 0) return [];

    const userMap = new Map<string, string>();
    for (const u of json.includes?.users ?? []) {
      userMap.set(u.id, u.username);
    }

    return json.data.slice(0, maxResults).map(t => ({
      authorUsername: t.author_id ? (userMap.get(t.author_id) ?? t.author_id) : 'unknown',
      text: t.text,
    }));
  } catch (err) {
    console.warn('[twitter] getTweetReplies error:', err);
    return [];
  }
}
