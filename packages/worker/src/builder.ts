import { fetchGemini } from './gemini.ts';

type GatewayConfig = { accountId: string; gateway: string; apiKey: string };

// Shared language detector (mirrors the one in llm.ts)
function detectSkillLang(skill: string): 'zh' | 'en' {
  if (!skill) return 'zh';
  const sample = skill.slice(0, 500);
  const cjkCount = (sample.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  return cjkCount / sample.length > 0.15 ? 'zh' : 'en';
}

async function xGet(urlPath: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`https://api.twitter.com/2${urlPath}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`X API ${urlPath} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchSourceTweets(
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

export async function distillSkillFromTweets(
  tweetsByAccount: Record<string, string[]>,
  geminiModel: string,
  promptLang: string = 'zh',
  gatewayConfig: GatewayConfig,
): Promise<string> {
  const blocks = Object.entries(tweetsByAccount)
    .map(([u, tweets]) => `### @${u}\n${tweets.map((t, i) => `${i + 1}. ${t}`).join('\n')}`)
    .join('\n\n');

  const prompt = promptLang === 'en'
    ? `You are a persona extraction engine. Analyze the following tweets and output ONLY a structured Markdown persona profile with these exact sections in order:

- **Background**: Identity, social context, areas of interest.
- **Core Traits**: 3–6 bullet points capturing the dominant personality dimensions.
- **Worldview (三观)**:
  - *View of the World*: How this person perceives society, humanity, and reality.
  - *View of Life*: Their philosophy on the purpose and meaning of life, success, and happiness.
  - *Value System*: What they consider right/wrong, important/unimportant; moral stances and priorities.
- **Verbal Tics & Catchphrases (口癖)**: A dedicated list of recurring words, filler phrases, sentence-ending particles, pet expressions, and structural patterns that define this person's idiolect. Provide concrete examples extracted verbatim or closely paraphrased from the source tweets.
- **Tone & Voice**: Overall register (formal/casual/ironic), code-switching habits, punctuation style, emoji usage.
- **Constraints**: Behavioral rules for the AI persona — reply length, when to output <skip>, hashtag policy.

Source tweets:
${blocks}

Generate the persona.skill document now using ONLY English:`
    : `你是一个人格提炼引擎。请分析以下推文，仅输出一份结构化的 Markdown 人格配置文档，包含以下章节（按序）：

- **背景设定**：身份、社交圈子、兴趣领域。
- **核心性格**：3–6 条性格维度要点。
- **三观**：
  - *世界观*：对社会、人性与现实的基本认知和判断。
  - *人生观*：对生命意义、成功与幸福的理解和态度。
  - *价值观*：是非判断标准、道德立场与优先级排序。
- **口癖**：专项列出这个人惯用的词汇、口头禅、句尾习惯、标志性表达和句式结构。要求从原推文中提取具体例子或高度接近的复现，让 AI 仿写时能精准复刻语感。
- **语气与腔调**：整体语域（正式/随意/反讽）、中英混用习惯、标点偏好、表情符号习惯。
- **行为约束**：AI 角色的行为规则——回复字数、何时输出 <skip>、话题标签策略。

源推文：
${blocks}

请用纯简体中文生成 persona.skill 文档：`;

  return fetchGemini(
    geminiModel,
    [{ role: 'user', parts: [{ text: prompt }] }],
    undefined,
    { maxOutputTokens: 16000, temperature: 0.4 },
    undefined,
    undefined,
    gatewayConfig,
  );
}

export async function genSample(skill: string, geminiModel: string, gatewayConfig: GatewayConfig) {
  const lang = detectSkillLang(skill);
  const cfg = (temp: number) => ({ maxOutputTokens: 1000, temperature: temp });
  const [a, b] = await Promise.all([
    fetchGemini(
      geminiModel,
      [{ role: 'user', parts: [{ text: lang === 'zh'
        ? '请用这个人设发一条自发推文（20字以内，不要解释）：'
        : 'Using this persona, post a spontaneous tweet (one or two short sentences, no explanation):' }] }],
      skill, cfg(1.1), undefined, undefined, gatewayConfig,
    ),
    fetchGemini(
      geminiModel,
      [{ role: 'user', parts: [{ text: lang === 'zh'
        ? '[@stranger] 说了:\n这你们华人都是一个怎么想的？\n请用这个人设回复（可以输出 <skip>）：'
        : '[@stranger] said:\nWhy do you people always think like that?\nReply using this persona (you may output <skip>):' }] }],
      skill, cfg(1.0), undefined, undefined, gatewayConfig,
    ),
  ]);
  return { tweet: a ?? '(error)', reply: b ?? '(error)' };
}

export async function refineSkill(
  skill: string, feedback: string, geminiModel: string, gatewayConfig: GatewayConfig
): Promise<string> {
  const lang = detectSkillLang(skill);
  const prompt = lang === 'zh'
    ? `根据以下用户反馈更新人格配置，保持Markdown结构，只输出完整的更新后Markdown文本。\n\n当前配置：\n\`\`\`\n${skill}\n\`\`\`\n\n用户反馈：${feedback}\n\n输出：`
    : `Update the persona configuration based on the following user feedback. Preserve the Markdown structure and all headings. Output only the complete updated Markdown text.\n\nCurrent config:\n\`\`\`\n${skill}\n\`\`\`\n\nUser feedback: ${feedback}\n\nOutput:`;
  const sysInst = lang === 'zh'
    ? '你是人格配置文件编辑引擎。保持Markdown结构和所有标题，只输出修改后的纯Markdown文本。'
    : 'You are a persona configuration editor. Preserve the Markdown structure and all headings. Output only the modified Markdown text.';

  return fetchGemini(
    geminiModel,
    [{ role: 'user', parts: [{ text: prompt }] }],
    sysInst,
    { maxOutputTokens: 16000, temperature: 0.4 },
    undefined,
    undefined,
    gatewayConfig,
  ).catch(() => skill);
}
