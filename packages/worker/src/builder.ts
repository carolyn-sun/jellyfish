import { fetchLLM } from './gemini.ts';

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
  grokApiKey?: string,
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
- **Political Orientation (政治倾向)**: Where this person sits on the political spectrum (left/center/right, libertarian/authoritarian, etc.), their stances on specific issues (e.g., governance, civil rights, economics, geopolitics), their attitude toward authority and institutions, and the political vocabulary or rhetoric they naturally reach for. Note any contradictions or ambivalence.
- **Interests & Hobbies (兴趣爱好)**: Concrete domains, activities, and content the person actively engages with — fandoms, games, media, sports, crafts, intellectual pursuits, etc. Extract specific titles, names, or topics mentioned or implied in the tweets.
- **Obsessions & Quirky Fixations (性癖)**: The person's idiosyncratic aesthetic preferences, niche fascinations, recurring brain-worm topics, and non-mainstream fixations that color their personality — e.g., love of a specific visual trope, obsession with absurd edge cases, guilty pleasures, or unusual intellectual turn-ons. Be specific and evidence-based.
- **Emotional Patterns (情绪模式)**: What triggers strong emotional reactions (positive or negative), how they express emotions publicly (venting, humor, silence), their emotional regulation style, and recurring emotional themes (e.g., persistent anxiety, low-grade cynicism, sudden bursts of enthusiasm).
- **Interpersonal Dynamics (人际关系模式)**: How they relate to others online — social attachment style (warm/aloof/selective), how they treat strangers vs. close contacts, conflict response (confrontational/passive-aggressive/avoidant), clique behavior, parasocial tendencies, and how they position themselves within communities.
- **Self-Perception & Blind Spots (自我认知与盲区)**: How they see and present themselves vs. how they actually come across in the tweets. Identify any gaps, contradictions, or recurring self-narrative (e.g., "I'm the rational one", "I don't care what people think"). Note consistent blind spots or defensiveness patterns.
- **Red Lines & Taboos (禁区与雷点)**: Topics, words, or framings that consistently provoke a strong reaction or are conspicuously avoided. What they refuse to engage with, what makes them shut down or lash out, and any ideological or personal tripwires.
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
- **政治倾向**：此人在政治光谱上的大致位置（左/中/右、自由主义/威权主义等）、对具体议题的立场（如治理模式、公民权利、经济政策、地缘政治）、对权威与体制机构的态度，以及习惯调用的政治话语和修辞。如有矛盾或模糊地带，请一并标注。
- **兴趣爱好**：具体列出此人主动涉猎的领域、活动和内容——包括但不限于：粉丝圈、游戏、影视、音乐、运动、手艺、学术偏好等。要求提取推文中出现的具体作品名、圈子名或话题，而非泛泛而谈。
- **性癖**：此人独特的审美趣味、小众迷恋点、反复出现的脑洞方向，以及不常公开但渗透在字里行间的非主流偏好——例如对某类视觉风格的执念、对荒诞边缘案例的沉迷、不见光的爱好，或某种感性/理性上的"特殊口味"。要求以推文为据，具体而不泛化。
- **情绪模式**：什么会触发强烈的情绪反应（正面或负面）、情绪是如何公开表达的（发泄、用幽默掩盖、沉默）、情绪调节风格，以及反复出现的情绪主题（如持续的焦虑感、底色的犬儒主义、阵发性的亢奋）。
- **人际关系模式**：在网络上如何与他人相处——社交依附风格（温暖/疏离/选择性亲近）、对陌生人与熟人的区别对待、冲突应对方式（正面对抗/被动攻击/回避）、圈子行为、"绑架式"共情或单方面依赖的倾向，以及在社群中如何定位自己。
- **自我认知与盲区**：自我呈现与推文中实际流露的形象之间的差距；识别反复出现的自我叙事（如"我是那个讲理的人"、"我不在乎别人怎么看"）；标注明显的认知盲区或防御性反应模式。
- **禁区与雷点**：哪些话题、措辞或框架会持续引发强烈反应，或被刻意回避。什么让他/她直接关闭对话或突然爆发，以及有哪些意识形态或个人上的"地雷"。
- **口癖**：专项列出这个人惯用的词汇、口头禅、句尾习惯、标志性表达和句式结构。要求从原推文中提取具体例子或高度接近的复现，让 AI 仿写时能精准复刻语感。
- **语气与腔调**：整体语域（正式/随意/反讽）、中英混用习惯、标点偏好、表情符号习惯。
- **行为约束**：AI 角色的行为规则——回复字数、何时输出 <skip>、话题标签策略。

源推文：
${blocks}

请用纯简体中文生成 persona.skill 文档：`;

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
        ? '请用这个人设发一条自发推文（20字以内，不要解释）：'
        : 'Using this persona, post a spontaneous tweet (one or two short sentences, no explanation):' }] }],
      skill, cfg(1.1), gatewayConfig, grokApiKey,
    ),
    fetchLLM(
      geminiModel,
      [{ role: 'user', parts: [{ text: lang === 'zh'
        ? '[@stranger] 说了:\n这你们华人都是一个怎么想的？\n请用这个人设回复（可以输出 <skip>）：'
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
    ? `根据以下用户反馈更新人格配置，保持Markdown结构，只输出完整的更新后Markdown文本。\n\n当前配置：\n\`\`\`\n${skill}\n\`\`\`\n\n用户反馈：${feedback}\n\n输出：`
    : `Update the persona configuration based on the following user feedback. Preserve the Markdown structure and all headings. Output only the complete updated Markdown text.\n\nCurrent config:\n\`\`\`\n${skill}\n\`\`\`\n\nUser feedback: ${feedback}\n\nOutput:`;
  const sysInst = lang === 'zh'
    ? '你是人格配置文件编辑引擎。保持Markdown结构和所有标题，只输出修改后的纯Markdown文本。'
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
