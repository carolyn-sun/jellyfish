/**
 * Module 2 — Tune (RLHF)
 * Shows the user a sample tweet + reply generated from the draft skill,
 * then iterates up to 10 rounds of feedback to refine the persona.skill.
 */
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { GoogleGenAI } from '@google/genai';

const MAX_ROUNDS = 10;
const MODEL = 'gemini-2.5-pro-preview-03-25';

interface TuneInput {
  draftSkill: string;
  geminiApiKey: string;
}

interface TuneResult {
  finalSkill: string;
}

// ─── Generate a sample tweet + reply pair from the current skill ───────────────
async function generateSample(skill: string, geminiApiKey: string): Promise<{ tweet: string; reply: string }> {
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

  const tweetRes = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: '请用这个人设发一条自发推文（20字以内，不要解释）：' }] }],
    config: { systemInstruction: skill, maxOutputTokens: 200, temperature: 1.1 },
  });
  const tweet = tweetRes.text?.trim() ?? '（生成推文失败）';

  const replyRes = await ai.models.generateContent({
    model: MODEL,
    contents: [{
      role: 'user',
      parts: [{ text: '[@stranger] 说了:\n这你们华人都是一个怎么想的？\n\n请用这个人设回复这条推文（你可以输出 <skip> 来表示你懒得理他）：' }],
    }],
    config: { systemInstruction: skill, maxOutputTokens: 200, temperature: 1.0 },
  });
  const reply = replyRes.text?.trim() ?? '（生成回复失败）';

  return { tweet, reply };
}

// ─── Apply user feedback to refine the skill ──────────────────────────────────
async function refineSkill(currentSkill: string, feedback: string, geminiApiKey: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

  const systemInstruction = `你是一个人格配置文件编辑引擎。你会根据用户的反馈，精准地更新一份 Markdown 格式的 AI 人格配置文件（skill）。

规则：
1. 保持原有的 Markdown 结构（Background, Core Traits, Ideological Framework, Tone & Voice, Constraints）。
2. 根据用户反馈，自然地修改或补充相关条款。
3. 只输出修改后的纯 Markdown 文本，不要添加任何解释。`;

  const prompt = `这是当前的人格配置：
\`\`\`markdown
${currentSkill}
\`\`\`

用户对生成内容的反馈：
${feedback}

请根据反馈更新人格配置并直接输出新版本：`;

  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { systemInstruction, maxOutputTokens: 4000, temperature: 0.4 },
  });

  return res.text?.trim() ?? currentSkill;
}

// ─── Main export ──────────────────────────────────────────────────────────────
export async function tunePersona({ draftSkill, geminiApiKey }: TuneInput): Promise<TuneResult> {
  let currentSkill = draftSkill;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    p.log.message('');
    p.log.message(pc.bold(pc.magenta(`── Round ${round}/${MAX_ROUNDS} — Generating sample output... ──────────────────`)));

    const spinner = p.spinner();
    spinner.start('Generating sample tweet and reply...');
    const { tweet, reply } = await generateSample(currentSkill, geminiApiKey);
    spinner.stop('Done');

    p.log.message('');
    p.log.message(pc.bold('📝 Sample spontaneous tweet:'));
    p.log.message(pc.cyan(`  "${tweet}"`));
    p.log.message('');
    p.log.message(pc.bold('💬 Sample reply to a random mention:'));
    p.log.message(pc.cyan(`  "${reply}"`));
    p.log.message('');

    const feedback = await p.text({
      message: `Does this match the persona? Describe what to adjust — or type ${pc.bold('done')} to finalize:`,
      placeholder: 'e.g. "Too formal. Should be more casual and use more Chinese slang." / done',
    }) as string;

    if (p.isCancel(feedback)) {
      p.log.message(pc.yellow('Cancelled — using current skill as-is'));
      break;
    }

    if (feedback.trim().toLowerCase() === 'done' || feedback.trim() === '') {
      p.log.success('Persona locked in! ✅');
      break;
    }

    const refineSpinner = p.spinner();
    refineSpinner.start('Refining persona based on your feedback...');
    currentSkill = await refineSkill(currentSkill, feedback, geminiApiKey);
    refineSpinner.stop(pc.green(`Round ${round} complete — persona updated`));

    if (round === MAX_ROUNDS) {
      p.log.warn('Maximum rounds reached. Finalizing current skill.');
    }
  }

  p.log.message('');
  p.log.success(pc.green('Final skill ready.'));

  return { finalSkill: currentSkill };
}
