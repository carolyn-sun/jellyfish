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

  const prompt = `You are a persona extraction engine. Analyze the following tweets and output ONLY a structured Markdown persona profile with these sections:\n- **Background**: Identity, social context, interests.\n- **Core Traits**: 3–6 personality bullet points.\n- **Ideological Framework**: Beliefs, values, stances.\n- **Tone & Voice**: Vocabulary, sentence patterns, quirks, code-switching habits.\n- Constraints: AI behavioral rules (reply length, hashtags, when to output <skip>).\n\nSource tweets:\n${blocks}\n\nIMPORTANT: You MUST generate the final persona document ENTIRELY in ${promptLang === 'en' ? 'English' : 'Simplified Chinese (中文)'}.\n\nGenerate the persona.skill document now:`;

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
