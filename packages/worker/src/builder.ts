import { fetchLLM } from './gemini.ts';

type GatewayConfig = { accountId: string; gateway: string; apiKey: string };

function detectSkillLang(skill: string): 'zh' | 'en' {
  if (!skill) return 'zh';
  const sample = skill.slice(0, 500);
  const cjkCount = (sample.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  return cjkCount / sample.length > 0.15 ? 'zh' : 'en';
}

// 10 s timeout — Twitter API normally responds in <2 s; without this a hanging
// request will exhaust the CF Workers wall-clock limit with no useful error.
async function xGet(urlPath: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`https://api.twitter.com/2${urlPath}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`X API ${urlPath} \u2192 ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Quality filter ─────────────────────────────────────────────────────────────
function filterQualityTweets(tweets: string[]): string[] {
  return tweets.filter(t => {
    const noUrl = t.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    if (noUrl.length < 15) return false;
    // Include CJK Extension A (U+3400-U+4DBF) to match detectSkillLang
    const alphaCount = (noUrl.match(/[a-zA-Z0-9\u3400-\u4dbf\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) ?? []).length;
    return alphaCount >= 5;
  });
}

// ── Diversity sampler ──────────────────────────────────────────────────────────
function sampleDiverse(tweets: string[], target = 30): string[] {
  if (tweets.length <= target) return tweets;
  const step = tweets.length / target;
  return Array.from({ length: target }, (_, i) =>
    tweets[Math.min(Math.round(i * step), tweets.length - 1)]!
  );
}

// ── Fetch source tweets (parallel) ────────────────────────────────────────────
// N accounts x 2 calls each would be 2N serial round-trips in a for-loop.
// Promise.all reduces wall-clock time to ~2 round-trips regardless of N.
export async function fetchSourceTweets(
  sourceAccounts: string[],
  accessToken: string,
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  await Promise.all(sourceAccounts.map(async username => {
    try {
      const u = await xGet(`/users/by/username/${username}`, accessToken) as { data?: { id: string } };
      if (!u.data) return;
      const params = new URLSearchParams({
        max_results: '50', 'tweet.fields': 'text', exclude: 'retweets,replies',
      });
      const t = await xGet(`/users/${u.data.id}/tweets?${params}`, accessToken) as
        { data?: { text: string }[] };
      if (t.data?.length) result[username] = t.data.map(x => x.text);
    } catch { /* skip failed accounts */ }
  }));
  return result;
}

// ── Phase 1: Focused voice extraction ─────────────────────────────────────────
async function extractVoiceFingerprint(
  blocks: string,
  lang: string,
  geminiModel: string,
  gatewayConfig: GatewayConfig,
  grokApiKey?: string,
): Promise<string> {
  // \u53e3\u7656 = \u53e3\u764b? No. Let me use raw strings here.
  // ZH: 分析以下推文，仅提取语言指纹（100字以内）
  // 口癖 = \u53e3\u7656
  const zhPrompt = [
    '\u5206\u6790\u4ee5\u4e0b\u63a8\u6587\uff0c\u4ec5\u63d0\u53d6\u8bed\u8a00\u6307\u7eb9\uff08100\u5b57\u4ee5\u5185\uff09\uff1a',
    '1. \u60ef\u7528\u8bcd\u6c47\u548c\u53e3\u7656\uff08\u5217\u4e073-5\u4e2a\uff09',
    '2. \u53e5\u5f0f\u504f\u597d\uff08\u77ed\u53e5/\u957f\u53e5\uff1f\u76f4\u63a5/\u8fc2\u56de\uff1f\uff09',
    '3. \u60c5\u7eea\u57fa\u8c03\uff08\u51b7\u6de1/\u70ed\u60c5/\u53cd\u8bbd\uff1f\uff09',
    '4. \u6700\u5e38\u89e6\u53d1\u7684\u8bdd\u9898',
    '',
    '\u63a8\u6587\uff1a',
    blocks,
    '',
    '\u4ec5\u8f93\u51fa\u7eaf\u6587\u672c\uff0c\u4e0d\u8981\u6807\u9898\uff1a',
  ].join('\n');

  const enPrompt = [
    'Analyze the tweets below and extract ONLY the voice fingerprint (100 words max):',
    '1. Signature words/phrases (3-5 examples)',
    '2. Sentence style (short/long? direct/indirect?)',
    '3. Emotional register (detached/enthusiastic/ironic?)',
    '4. Most frequent trigger topics',
    '',
    'Tweets:',
    blocks,
    '',
    'Output plain text only, no headings:',
  ].join('\n');

  return fetchLLM(
    geminiModel,
    [{ role: 'user', parts: [{ text: lang === 'zh' ? zhPrompt : enPrompt }] }],
    undefined,
    { maxOutputTokens: 500, temperature: 0.3 },
    gatewayConfig,
    grokApiKey,
  );
}

export async function distillSkillFromTweets(
  tweetsByAccount: Record<string, string[]>,
  geminiModel: string,
  promptLang: string = 'zh',
  gatewayConfig: GatewayConfig,
  grokApiKey?: string,
): Promise<string> {
  // Normalize to strict 'zh' | 'en' — callers may pass 'zh-CN', 'chinese', etc.
  // Using a single canonical value ensures fingerprint and synthesis always use the same language.
  const lang: 'zh' | 'en' = promptLang === 'en' ? 'en' : 'zh';

  const filtered = Object.fromEntries(
    Object.entries(tweetsByAccount).map(([u, tweets]) => [
      u, sampleDiverse(filterQualityTweets(tweets)),
    ])
  );

  // Fallback: if quality filter removed everything, use original unfiltered tweets
  const hasContent = Object.values(filtered).some(t => t.length > 0);
  const source = hasContent ? filtered : tweetsByAccount;

  const entries = Object.entries(source).filter(([, tweets]) => tweets.length > 0);
  const blocks = entries
    .map(([u, tweets]) => `### @${u}\n${tweets.map((t, i) => `${i + 1}. ${t}`).join('\n')}`)
    .join('\n\n');

  // Voice fingerprint (serial). Fails gracefully — synthesis can proceed without it.
  // Skipped for multi-account to avoid blurred average-persona fingerprints.
  const singleAccount = entries.length === 1;
  const voiceFingerprint = singleAccount
    ? await extractVoiceFingerprint(blocks, lang, geminiModel, gatewayConfig, grokApiKey)
        .catch(() => '')
    : '';

  // Verified codepoints (node -e "...'癖 腔 值'.split('').map(c=>c.codePointAt(0).toString(16))"):
  // \u7656 = 癖  \u8154 = 腔  \u503c = 值
  const KOU_PI = '\u53e3\u7656'; // 口癖
  const XING_PI = '\u6027\u7656'; // 性癖
  const QIANG_DIAO = '\u8154\u8c03'; // 腔调
  const JIA_ZHI_GUAN = '\u4ef7\u503c\u89c2'; // 价值观

  const voicePreamble = voiceFingerprint
    ? lang === 'zh'
      ? `\u3010\u9884\u63d0\u53d6\u7684\u8bed\u8a00\u6307\u7eb9\uff08\u8bf7\u5728${KOU_PI}/\u8bed\u6c14\u7ae0\u8282\u4e2d\u878d\u5408\u8fd9\u4e9b\u7279\u5f81\uff09\u3011\n${voiceFingerprint}\n\n`
      : `[Pre-extracted voice fingerprint \u2014 integrate into the Verbal Tics and Tone sections]\n${voiceFingerprint}\n\n`
    : '';

  const enSections = [
    '- **Background**: Identity, social context, areas of interest.',
    '- **Core Traits**: 3\u20136 bullet points capturing the dominant personality dimensions.',
    '- **Worldview**:',
    '  - *View of the World*: How this person perceives society, humanity, and reality.',
    '  - *View of Life*: Their philosophy on life\u2019s purpose, success, and happiness.',
    '  - *Value System*: What they consider right/wrong; moral stances and priorities.',
    '- **Political Orientation**: Spectrum position, issue stances, attitude toward authority, political rhetoric.',
    '- **Interests & Hobbies**: Concrete domains \u2014 extract specific titles, names, or topics.',
    `- **Obsessions & Quirky Fixations (${XING_PI})**: Idiosyncratic aesthetic preferences, niche fascinations.`,
    '- **Emotional Patterns**: Triggers, expression style, recurring emotional themes.',
    '- **Interpersonal Dynamics**: Social attachment style, conflict response, community positioning.',
    '- **Self-Perception & Blind Spots**: Gaps between self-presentation and actual behavior.',
    '- **Red Lines & Taboos**: Topics or framings that provoke strong reactions.',
    `- **Verbal Tics & Catchphrases (${KOU_PI})**: Recurring words, filler phrases, pet expressions with verbatim examples.`,
    '- **Tone & Voice**: Overall register, code-switching habits, punctuation and emoji style.',
    '- **Constraints**: Behavioral rules \u2014 reply length, when to output <skip>, hashtag policy.',
  ].join('\n');

  const zhSections = [
    '\u80cc\u666f\u8bbe\u5b9a\uff1a\u8eab\u4efd\u3001\u793e\u4ea4\u5708\u5b50\u3001\u5174\u8da3\u9886\u57df\u3002',
    '\u6838\u5fc3\u6027\u683c\uff1a3\u20136 \u6761\u6027\u683c\u7ef4\u5ea6\u8981\u70b9\u3002',
    '\u4e09\u89c2\uff1a',
    `  \u4e16\u754c\u89c2\uff1a\u5bf9\u793e\u4f1a\u3001\u4eba\u6027\u4e0e\u73b0\u5b9e\u7684\u57fa\u672c\u8ba4\u77e5\u3002`,
    `  \u4eba\u751f\u89c2\uff1a\u5bf9\u751f\u547d\u610f\u4e49\u3001\u6210\u529f\u4e0e\u5e78\u798f\u7684\u7406\u89e3\u3002`,
    `  ${JIA_ZHI_GUAN}\uff1a\u662f\u975e\u5224\u65ad\u6807\u51c6\u3001\u9053\u5fb7\u7acb\u573a\u4e0e\u4f18\u5148\u7ea7\u6392\u5e8f\u3002`,
    '\u653f\u6cbb\u503e\u5411\uff1a\u5149\u8c31\u4f4d\u7f6e\u3001\u5177\u4f53\u8bae\u9898\u7acb\u573a\u3001\u5bf9\u6743\u5a01\u7684\u6001\u5ea6\u3001\u4e60\u60ef\u8bdd\u8bed\u3002',
    '\u5174\u8da3\u7231\u597d\uff1a\u5177\u4f53\u9886\u57df\u3001\u6d3b\u52a8\u548c\u5185\u5bb9\uff0c\u63d0\u53d6\u63a8\u6587\u4e2d\u7684\u5177\u4f53\u4f5c\u54c1\u540d\u6216\u8bdd\u9898\u3002',
    `${XING_PI}\uff1a\u72ec\u7279\u5ba1\u7f8e\u8da3\u5473\u3001\u5c0f\u4f17\u8ff7\u604b\u70b9\u3001\u53cd\u590d\u51fa\u73b0\u7684\u8111\u6d1e\uff0c\u4ee5\u63a8\u6587\u4e3a\u636e\u3002`,
    '\u60c5\u7eea\u6a21\u5f0f\uff1a\u89e6\u53d1\u56e0\u7d20\u3001\u8868\u8fbe\u65b9\u5f0f\u3001\u53cd\u590d\u51fa\u73b0\u7684\u60c5\u7eea\u4e3b\u9898\u3002',
    '\u4eba\u9645\u5173\u7cfb\u6a21\u5f0f\uff1a\u793e\u4ea4\u4f9d\u9644\u98ce\u683c\u3001\u51b2\u7a81\u5e94\u5bf9\u3001\u5728\u793e\u7fa4\u4e2d\u5982\u4f55\u5b9a\u4f4d\u81ea\u5df1\u3002',
    '\u81ea\u6211\u8ba4\u77e5\u4e0e\u76f2\u533a\uff1a\u81ea\u6211\u5448\u73b0\u4e0e\u5b9e\u9645\u6d41\u9732\u5f62\u8c61\u7684\u5dee\u8ddd\u3002',
    '\u7981\u533a\u4e0e\u96f7\u70b9\uff1a\u6301\u7eed\u5f15\u53d1\u5f3a\u70c8\u53cd\u5e94\u6216\u88ab\u523b\u610f\u56de\u907f\u7684\u8bdd\u9898\u3002',
    `${KOU_PI}\uff1a\u60ef\u7528\u8bcd\u6c47\u3001\u53e3\u5934\u7985\u3001\u53e5\u5c3e\u4e60\u60ef\u3001\u6807\u5fd7\u6027\u8868\u8fbe\uff0c\u4ece\u539f\u63a8\u6587\u63d0\u53d6\u5177\u4f53\u4f8b\u5b50\u3002`,
    `\u8bed\u6c14\u4e0e${QIANG_DIAO}\uff1a\u6574\u4f53\u8bed\u57df\u3001\u4e2d\u82f1\u6df7\u7528\u4e60\u60ef\u3001\u6807\u70b9\u504f\u597d\u3001\u8868\u60c5\u7b26\u53f7\u4e60\u60ef\u3002`,
    'AI \u884c\u4e3a\u7ea6\u675f\uff1a\u56de\u590d\u5b57\u6570\u3001\u4f55\u65f6\u8f93\u51fa <skip>\u3001\u8bdd\u9898\u6807\u7b7e\u7b56\u7565\u3002',
  ].map(s => `- **${s}**`).join('\n');

  const prompt = lang === 'en'
    ? `${voicePreamble}You are a persona extraction engine. Analyze the tweets below and output ONLY a structured Markdown persona profile with these exact sections:\n\n${enSections}\n\nSource tweets:\n${blocks}\n\nGenerate the persona.skill document now using ONLY English:`
    : `${voicePreamble}\u4f60\u662f\u4e00\u4e2a\u4eba\u683c\u63d0\u70bc\u5f15\u64ce\u3002\u8bf7\u5206\u6790\u4ee5\u4e0b\u63a8\u6587\uff0c\u4ec5\u8f93\u51fa\u4e00\u4efd\u7ed3\u6784\u5316\u7684 Markdown \u4eba\u683c\u914d\u7f6e\u6587\u6863\uff0c\u5305\u542b\u4ee5\u4e0b\u7ae0\u8282\uff08\u6309\u5e8f\uff09\uff1a\n\n${zhSections}\n\n\u6e90\u63a8\u6587\uff1a\n${blocks}\n\n\u8bf7\u7528\u7eaf\u7b80\u4f53\u4e2d\u6587\u751f\u6210 persona.skill \u6587\u6863\uff1a`;

  return fetchLLM(
    geminiModel,
    [{ role: 'user', parts: [{ text: prompt }] }],
    undefined,
    { maxOutputTokens: 16000, temperature: 0.4 },
    gatewayConfig,
    grokApiKey,
  );
}

export async function genSample(skill: string, geminiModel: string, gatewayConfig: GatewayConfig, grokApiKey?: string) {
  const lang = detectSkillLang(skill);
  const cfg = (temp: number) => ({ maxOutputTokens: 1000, temperature: temp });
  const [a, b] = await Promise.all([
    fetchLLM(
      geminiModel,
      [{ role: 'user', parts: [{ text: lang === 'zh'
        ? '\u8bf7\u7528\u8fd9\u4e2a\u4eba\u8bbe\u53d1\u4e00\u6761\u81ea\u53d1\u63a8\u6587\uff0820\u5b57\u4ee5\u5185\uff0c\u4e0d\u8981\u89e3\u91ca\uff09\uff1a'
        : 'Using this persona, post a spontaneous tweet (one or two short sentences, no explanation):' }] }],
      skill, cfg(1.1), gatewayConfig, grokApiKey,
    ),
    fetchLLM(
      geminiModel,
      [{ role: 'user', parts: [{ text: lang === 'zh'
        ? '[@stranger] \u8bf4\u4e86:\n\u8fd9\u4f60\u4eec\u534e\u4eba\u90fd\u662f\u4e00\u4e2a\u600e\u4e48\u60f3\u7684\uff1f\n\u8bf7\u7528\u8fd9\u4e2a\u4eba\u8bbe\u56de\u590d\uff08\u53ef\u4ee5\u8f93\u51fa <skip>\uff09\uff1a'
        : '[@stranger] said:\nWhy do you people always think like that?\nReply using this persona (you may output <skip>):' }] }],
      skill, cfg(1.0), gatewayConfig, grokApiKey,
    ),
  ]);
  return { tweet: a ?? '(error)', reply: b ?? '(error)' };
}

export async function refineSkill(
  skill: string, feedback: string, geminiModel: string, gatewayConfig: GatewayConfig, grokApiKey?: string
): Promise<string> {
  const lang = detectSkillLang(skill);
  const prompt = lang === 'zh'
    ? `\u6839\u636e\u4ee5\u4e0b\u7528\u6237\u53cd\u9988\u66f4\u65b0\u4eba\u683c\u914d\u7f6e\uff0c\u4fdd\u6301Markdown\u7ed3\u6784\uff0c\u53ea\u8f93\u51fa\u5b8c\u6574\u7684\u66f4\u65b0\u540eMarkdown\u6587\u672c\u3002\n\n\u5f53\u524d\u914d\u7f6e\uff1a\n\`\`\`\n${skill}\n\`\`\`\n\n\u7528\u6237\u53cd\u9988\uff1a${feedback}\n\n\u8f93\u51fa\uff1a`
    : `Update the persona configuration based on the following feedback. Preserve the Markdown structure. Output only the complete updated Markdown.\n\nCurrent config:\n\`\`\`\n${skill}\n\`\`\`\n\nFeedback: ${feedback}\n\nOutput:`;
  const sysInst = lang === 'zh'
    ? '\u4f60\u662f\u4eba\u683c\u914d\u7f6e\u6587\u4ef6\u7f16\u8f91\u5f15\u64ce\u3002\u4fdd\u6301Markdown\u7ed3\u6784\u548c\u6240\u6709\u6807\u9898\uff0c\u53ea\u8f93\u51fa\u4fee\u6539\u540e\u7684\u7eaf Markdown \u6587\u672c\u3002'
    : 'You are a persona configuration editor. Preserve the Markdown structure and all headings. Output only the modified Markdown text.';

  return fetchLLM(
    geminiModel,
    [{ role: 'user', parts: [{ text: prompt }] }],
    sysInst,
    { maxOutputTokens: 16000, temperature: 0.4 },
    gatewayConfig,
    grokApiKey,
  ).catch(() => skill);
}
