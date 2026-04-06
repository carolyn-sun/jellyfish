/**
 * Web Wizard Server
 * Serves the browser-based configuration wizard at http://localhost:3000
 */
import express from 'express';
import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import { exec } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const HTML_PATH       = path.join(__dirname, '../public/index.html');
const GENERATED_DIR   = path.resolve(__dirname, '../../worker/generated');
const WORKER_DIR      = path.resolve(__dirname, '../../worker');
const REDIRECT_URI    = 'http://localhost:3000/callback';

// ─── OAuth session store ──────────────────────────────────────────────────────
interface OAuthSession {
  state: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  expiresAt: number;
  status: 'pending' | 'done' | 'error';
  accessToken?: string;
  refreshToken?: string;
  error?: string;
}
const oauthSessions = new Map<string, OAuthSession>();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of oauthSessions.entries()) {
    if (s.expiresAt < now) oauthSessions.delete(id);
  }
}, 5 * 60 * 1000);

// ─── X API helpers ────────────────────────────────────────────────────────────
async function xGet(urlPath: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`https://api.twitter.com/2${urlPath}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`X API ${urlPath} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchSourceTweets(
  sourceAccounts: string[],
  accessToken: string,
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const username of sourceAccounts) {
    try {
      const u = await xGet(`/users/by/username/${username}`, accessToken) as { data?: { id: string } };
      if (!u.data) continue;
      const params = new URLSearchParams({
        max_results: '50', 'tweet.fields': 'text', exclude: 'retweets,replies',
      });
      const t = await xGet(`/users/${u.data.id}/tweets?${params}`, accessToken) as
        { data?: { text: string }[] };
      if (t.data?.length) result[username] = t.data.map(x => x.text);
    } catch { /* skip failed accounts */ }
  }
  return result;
}

// ─── Gemini helpers ───────────────────────────────────────────────────────────
async function distillSkillFromTweets(
  tweetsByAccount: Record<string, string[]>,
  geminiApiKey: string,
  geminiModel: string,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const blocks = Object.entries(tweetsByAccount)
    .map(([u, tweets]) => `### @${u}\n${tweets.map((t, i) => `${i + 1}. ${t}`).join('\n')}`)
    .join('\n\n');

  const prompt = `You are a persona extraction engine. Analyze the following tweets and output ONLY a structured Markdown persona profile with these sections:
- **Background**: Identity, social context, interests.
- **Core Traits**: 3–6 personality bullet points.
- **Ideological Framework**: Beliefs, values, stances.
- **Tone & Voice**: Vocabulary, sentence patterns, quirks, code-switching habits.
- **Constraints**: AI behavioral rules (reply length, hashtags, when to output <skip>).

Source tweets:
${blocks}

Generate the persona.skill document now:`;

  const res = await ai.models.generateContent({
    model: geminiModel,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { maxOutputTokens: 4000, temperature: 0.4 },
  });
  const text = res.text?.trim();
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

async function genSample(skill: string, geminiApiKey: string, geminiModel: string) {
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const cfg = (temp: number) => ({ systemInstruction: skill, maxOutputTokens: 200, temperature: temp });
  const [a, b] = await Promise.all([
    ai.models.generateContent({ model: geminiModel, config: cfg(1.1),
      contents: [{ role: 'user', parts: [{ text: '请用这个人设发一条自发推文（20字以内，不要解释）：' }] }] }),
    ai.models.generateContent({ model: geminiModel, config: cfg(1.0),
      contents: [{ role: 'user', parts: [{ text: '[@stranger] 说了:\n这你们华人都是一个怎么想的？\n请用这个人设回复（可以输出 <skip>）：' }] }] }),
  ]);
  return { tweet: a.text?.trim() ?? '(error)', reply: b.text?.trim() ?? '(error)' };
}

async function refineSkill(
  skill: string, feedback: string, geminiApiKey: string, geminiModel: string,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const res = await ai.models.generateContent({
    model: geminiModel,
    contents: [{ role: 'user', parts: [{ text:
      `根据以下用户反馈更新人格配置，保持Markdown结构，只输出完整的更新后Markdown文本。\n\n当前配置：\n\`\`\`\n${skill}\n\`\`\`\n\n用户反馈：${feedback}\n\n输出：` }] }],
    config: {
      systemInstruction: '你是人格配置文件编辑引擎。保持Markdown结构和所有标题，只输出修改后的纯Markdown文本。',
      maxOutputTokens: 4000, temperature: 0.4,
    },
  });
  return res.text?.trim() ?? skill;
}

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string) {
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
  });
  const data = await res.json() as { access_token?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/', (_req: Request, res: Response) => {
  res.send(readFileSync(HTML_PATH, 'utf8'));
});

// ── OAuth: start PKCE ─────────────────────────────────────────────────────────
app.post('/api/oauth/start', (req: Request, res: Response) => {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) { res.status(500).json({ error: 'Server missing X_CLIENT_ID or X_CLIENT_SECRET' }); return; }

  const sessionId    = randomBytes(16).toString('hex');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state        = randomBytes(16).toString('hex');

  const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  oauthSessions.set(sessionId, {
    state, codeVerifier, clientId, clientSecret,
    expiresAt: Date.now() + 10 * 60 * 1000, status: 'pending',
  });
  res.json({ sessionId, authUrl: authUrl.toString() });
});

// ── OAuth: poll result ────────────────────────────────────────────────────────
app.get('/api/oauth/result', (req: Request, res: Response) => {
  const sessionId = req.query['sessionId'] as string;
  const session   = oauthSessions.get(sessionId);
  if (!session) { res.status(404).json({ error: 'Session not found or expired' }); return; }
  if (session.status === 'pending') { res.json({ status: 'pending' }); return; }
  const { status, accessToken, refreshToken, error } = session;
  oauthSessions.delete(sessionId);
  res.json({ status, accessToken, refreshToken, error });
});

// ── OAuth: callback ───────────────────────────────────────────────────────────
app.get('/callback', async (req: Request, res: Response) => {
  const code  = req.query['code']  as string | undefined;
  const state = req.query['state'] as string | undefined;
  const error = req.query['error'] as string | undefined;

  let session: OAuthSession | undefined;
  for (const s of oauthSessions.values()) {
    if (s.state === state) { session = s; break; }
  }

  const successPage = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>授权成功</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);border-radius:16px;padding:48px;text-align:center}
h2{color:#8b5cf6}p{color:#94a3b8}</style></head>
<body><div class="c"><h2>✅ 授权成功！</h2><p>请回到向导页面继续操作。</p><p style="font-size:13px;color:#64748b">这个页面可以关闭了。</p></div></body></html>`;

  if (!session) { res.status(400).send('<h2>❌ Session not found</h2>'); return; }
  if (error) {
    session.status = 'error'; session.error = `Authorization denied: ${error}`;
    res.send('<h2>❌ Authorization denied. You can close this tab.</h2>'); return;
  }
  if (!code) { session.status = 'error'; session.error = 'No code'; res.status(400).send('No code'); return; }

  try {
    const creds = Buffer.from(`${session.clientId}:${session.clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
      body: new URLSearchParams({
        code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI,
        code_verifier: session.codeVerifier, client_id: session.clientId,
      }).toString(),
    });
    const data = await tokenRes.json() as { access_token?: string; refresh_token?: string; error?: string };
    if (!tokenRes.ok || !data.access_token) {
      session.status = 'error'; session.error = JSON.stringify(data);
      res.status(500).send('<h2>❌ Token exchange failed. Check wizard terminal.</h2>'); return;
    }
    session.status = 'done';
    session.accessToken  = data.access_token;
    session.refreshToken = data.refresh_token ?? '';
    res.send(successPage);
  } catch (err) {
    session.status = 'error'; session.error = String(err);
    res.status(500).send('<h2>❌ Internal error</h2>');
  }
});

// ── OAuth: refresh token → access token (for skip case) ──────────────────────
app.post('/api/oauth/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body as Record<string, string>;
  const clientId = process.env.X_CLIENT_ID ?? '';
  const clientSecret = process.env.X_CLIENT_SECRET ?? '';
  try {
    const accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken ?? '');
    res.json({ accessToken });
  } catch (err) { res.status(400).json({ error: String(err) }); }
});

// ── Distill ───────────────────────────────────────────────────────────────────
app.post('/api/distill', async (req: Request, res: Response) => {
  const { sourceAccounts, accessToken, geminiApiKey, geminiModel } =
    req.body as { sourceAccounts: string[]; accessToken: string; geminiApiKey: string; geminiModel: string };
  try {
    const tweetsByAccount = await fetchSourceTweets(sourceAccounts, accessToken);
    const accountCount = Object.keys(tweetsByAccount).length;
    if (accountCount === 0) {
      res.status(400).json({ error: 'No tweets fetched. Check source account names and access token.' }); return;
    }
    const skill = await distillSkillFromTweets(tweetsByAccount, geminiApiKey, geminiModel);
    const fetched: Record<string, number> = {};
    for (const [k, v] of Object.entries(tweetsByAccount)) fetched[k] = v.length;
    res.json({ skill, fetched });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── Tune ──────────────────────────────────────────────────────────────────────
app.post('/api/tune/sample', async (req: Request, res: Response) => {
  const { skill, geminiApiKey, geminiModel } = req.body as Record<string, string>;
  try { res.json(await genSample(skill ?? '', geminiApiKey ?? '', geminiModel ?? '')); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/tune/refine', async (req: Request, res: Response) => {
  const { skill, feedback, geminiApiKey, geminiModel } = req.body as Record<string, string>;
  try { res.json({ skill: await refineSkill(skill ?? '', feedback ?? '', geminiApiKey ?? '', geminiModel ?? '') }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── Save files ────────────────────────────────────────────────────────────────
app.post('/api/save', (req: Request, res: Response) => {
  const { config, skill, refreshToken, geminiApiKey } =
    req.body as { config: object; skill: string; refreshToken: string; geminiApiKey: string };
  const xClientId = process.env.X_CLIENT_ID ?? '';
  const xClientSecret = process.env.X_CLIENT_SECRET ?? '';
  try {
    mkdirSync(GENERATED_DIR, { recursive: true });
    const adminSecret = randomBytes(24).toString('hex');
    const configPath  = path.join(GENERATED_DIR, 'config.json');
    const skillPath   = path.join(GENERATED_DIR, 'persona.skill');
    const devVarsPath = path.join(WORKER_DIR, '.dev.vars');
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    writeFileSync(skillPath, skill, 'utf8');
    writeFileSync(devVarsPath, [
      '# Generated by Twitter Agent Wizard — DO NOT commit this file',
      `GEMINI_API_KEY=${geminiApiKey}`,
      `X_CLIENT_ID=${xClientId}`,
      `X_CLIENT_SECRET=${xClientSecret}`,
      `X_REFRESH_TOKEN=${refreshToken}`,
      `ADMIN_SECRET=${adminSecret}`,
    ].join('\n') + '\n', 'utf8');
    res.json({ configPath, skillPath, devVarsPath, adminSecret });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── List available Gemini models ─────────────────────────────────────────────
app.get('/api/models', async (req: Request, res: Response) => {
  const key = req.query['key'] as string | undefined;
  if (!key) { res.status(400).json({ error: 'Missing key' }); return; }
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const models: string[] = [];
    const pager = await ai.models.list();
    for await (const m of pager) {
      const name = m.name ?? '';
      // Only include models that support generateContent
      const supported = m.supportedActions ?? (m as Record<string, unknown>)['supportedGenerationMethods'] ?? [];
      const supportsGenerate = Array.isArray(supported)
        ? supported.some((a: unknown) => typeof a === 'string' && a.toLowerCase().includes('generate'))
        : true; // unknown — include anyway
      if (supportsGenerate && name.includes('gemini')) {
        // Return just the model id (strip "models/" prefix)
        models.push(name.replace(/^models\//, ''));
      }
    }
    models.sort((a, b) => {
      // Put 2.5 > 2.0 > 1.5; pro > flash > nano
      const rank = (s: string) =>
        (s.includes('2.5') ? 300 : s.includes('2.0') ? 200 : s.includes('1.5') ? 100 : 0) +
        (s.includes('pro') ? 30 : s.includes('flash') ? 20 : s.includes('nano') ? 10 : 0);
      return rank(b) - rank(a);
    });
    res.json({ models });
  } catch (err) { res.status(400).json({ error: String(err) }); }
});

export function startServer(port = 3000): void {
  app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n🔮  Twitter Agent Wizard`);
    console.log(`📡  ${url}\n`);
    openBrowser(url);
  });
}
