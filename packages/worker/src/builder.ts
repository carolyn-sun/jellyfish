import { GoogleGenAI } from '@google/genai';

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
  geminiApiKey: string,
  geminiModel: string,
  promptLang: string = 'zh'
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
- Constraints: AI behavioral rules (reply length, hashtags, when to output <skip>).

Source tweets:
${blocks}

IMPORTANT: You MUST generate the final persona document ENTIRELY in ${promptLang === 'en' ? 'English' : 'Simplified Chinese (中文)'}.

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

export async function genSample(skill: string, geminiApiKey: string, geminiModel: string) {
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

export async function refineSkill(
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
