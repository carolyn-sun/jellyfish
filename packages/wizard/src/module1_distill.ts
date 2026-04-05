/**
 * Module 1 — Distill
 * Collects API keys, source X accounts, fetches their tweets,
 * and distills an initial persona.skill via Gemini.
 */
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { GoogleGenAI } from '@google/genai';

const X_API_BASE = 'https://api.twitter.com/2';

interface XUser {
  id: string;
  name: string;
  username: string;
}

interface XTweet {
  id: string;
  text: string;
}

// ─── X API helpers (Bearer Token, app-only auth) ──────────────────────────────

async function xGet(path: string, bearerToken: string): Promise<unknown> {
  const res = await fetch(`${X_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API ${path} failed ${res.status}: ${body}`);
  }
  return res.json();
}

async function getUserByUsername(username: string, bearerToken: string): Promise<XUser | null> {
  try {
    const json = await xGet(`/users/by/username/${username}`, bearerToken) as { data?: XUser };
    return json.data ?? null;
  } catch {
    return null;
  }
}

async function getUserTweets(userId: string, bearerToken: string, maxResults = 50): Promise<XTweet[]> {
  try {
    const params = new URLSearchParams({
      max_results: String(Math.min(maxResults, 100)),
      'tweet.fields': 'text,created_at',
      exclude: 'retweets,replies',
    });
    const json = await xGet(`/users/${userId}/tweets?${params}`, bearerToken) as { data?: XTweet[] };
    return json.data ?? [];
  } catch {
    return [];
  }
}

// ─── Gemini distillation ──────────────────────────────────────────────────────

async function distillSkillFromTweets(
  tweetsByAccount: Map<string, string[]>,
  geminiApiKey: string,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

  const tweetBlocks = Array.from(tweetsByAccount.entries())
    .map(([user, tweets]) => `### @${user}\n${tweets.map((t, i) => `${i + 1}. ${t}`).join('\n')}`)
    .join('\n\n');

  const prompt = `You are a persona extraction engine. Analyze the following collection of tweets from one or more X (Twitter) accounts and synthesize their combined personality into a structured Markdown persona profile.

Output ONLY the Markdown document — no preamble, no explanation.

The document must contain the following sections:
- **Background**: Who this person is, their identity, social context, what they care about.
- **Core Traits**: Personality characteristics (3–6 bullet points).
- **Ideological Framework**: Their beliefs, values, social stances, things they defend or oppose.
- **Tone & Voice**: How they speak — vocabulary, sentence patterns, recurring phrases, emotional register, and any unique linguistic quirks (e.g. language code-switching, punctuation habits).
- **Constraints**: Behavioral rules for the AI (e.g. reply length limits, avoid hashtags, when to skip reply).

---

Here are the source tweets:

${tweetBlocks}

---

Generate the persona.skill Markdown document now:`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-pro-preview-03-25',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { maxOutputTokens: 4000, temperature: 0.4 },
  });

  const text = response.text?.trim();
  if (!text) throw new Error('Gemini returned empty response during distillation');
  return text;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface DistillResult {
  draftSkill: string;
  sourceAccounts: string[];
  geminiApiKey: string;
  xBearerToken: string;
  agentName: string;
  agentHandle: string;
}

export async function distillPersona(): Promise<DistillResult> {
  // Collect API credentials
  const geminiApiKey = await p.password({
    message: 'Enter your Gemini API Key:',
    validate: (v: string | undefined) => v == null || v.trim().length === 0 ? 'Required' : undefined,
  }) as string;
  if (p.isCancel(geminiApiKey)) process.exit(0);

  const xBearerToken = await p.password({
    message: 'Enter your X (Twitter) Bearer Token (for fetching public tweets):',
    validate: (v: string | undefined) => v == null || v.trim().length === 0 ? 'Required' : undefined,
  }) as string;
  if (p.isCancel(xBearerToken)) process.exit(0);

  // Agent identity
  const agentName = await p.text({
    message: "What is your agent's display name?",
    placeholder: 'e.g. Rebma',
    validate: (v: string | undefined) => v == null || v.trim().length === 0 ? 'Required' : undefined,
  }) as string;
  if (p.isCancel(agentName)) process.exit(0);

  const agentHandle = await p.text({
    message: 'What is the X @handle of the agent account (without @)?',
    placeholder: 'e.g. amber_digit',
    validate: (v: string | undefined) => v == null || v.trim().length === 0 ? 'Required' : undefined,
  }) as string;
  if (p.isCancel(agentHandle)) process.exit(0);

  // Source accounts to clone from
  const sourceInput = await p.text({
    message: 'Enter X @usernames to clone from (comma-separated, without @):',
    placeholder: 'e.g. amber_medusozoa, amber_toffee',
    validate: (v: string | undefined) => v == null || v.trim().length === 0 ? 'Please enter at least one username' : undefined,
  }) as string;
  if (p.isCancel(sourceInput)) process.exit(0);

  const sourceAccounts = (sourceInput as string).split(',').map((s: string) => s.trim()).filter(Boolean);

  // Fetch tweets from each source account
  const spinner = p.spinner();
  spinner.start(`Fetching tweets from ${sourceAccounts.length} account(s)...`);

  const tweetsByAccount = new Map<string, string[]>();
  const resolvedAccounts: string[] = [];

  for (const username of sourceAccounts) {
    const user = await getUserByUsername(username, xBearerToken as string);
    if (!user) {
      p.log.warn(`Could not find @${username} — skipping`);
      continue;
    }
    const tweets = await getUserTweets(user.id, xBearerToken as string, 50);
    if (tweets.length === 0) {
      p.log.warn(`No public tweets found for @${username} — skipping`);
      continue;
    }
    tweetsByAccount.set(username, tweets.map(t => t.text));
    resolvedAccounts.push(username);
    spinner.message(`Fetched ${tweets.length} tweets from @${username}`);
  }

  if (tweetsByAccount.size === 0) {
    spinner.stop('Failed to fetch any tweets');
    p.log.error('No tweets could be fetched. Please check your Bearer Token and usernames.');
    process.exit(1);
  }

  spinner.message(`Distilling persona from ${Array.from(tweetsByAccount.values()).flat().length} tweets via Gemini...`);

  const draftSkill = await distillSkillFromTweets(tweetsByAccount, geminiApiKey as string);

  spinner.stop(`✓ Persona distilled from ${resolvedAccounts.map(u => '@' + u).join(', ')}`);

  p.log.message('');
  p.log.message(pc.bold(pc.cyan('── Draft Skill Preview (first 600 chars) ──────────────────────────────')));
  p.log.message(pc.dim(draftSkill.slice(0, 600) + (draftSkill.length > 600 ? '\n...' : '')));
  p.log.message(pc.bold(pc.cyan('────────────────────────────────────────────────────────────────────────')));

  return {
    draftSkill,
    sourceAccounts: resolvedAccounts,
    geminiApiKey: geminiApiKey as string,
    xBearerToken: xBearerToken as string,
    agentName: agentName as string,
    agentHandle: agentHandle as string,
  };
}

