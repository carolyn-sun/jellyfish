import { fetchLLM } from './gemini.ts';

type GatewayConfig = { accountId: string; gateway: string; apiKey: string };

// Prompt budget limits — keeps total prompt under ~5 k tokens and avoids CF Workers timeout.
const SKILL_EXCERPT_CHARS = 3000;
const MAX_TWEETS_PER_ACCOUNT = 20;
const TRAJECTORIES_PER_CALL = 3;

// ── Output format ──────────────────────────────────────────────────────────────
// Training data is stored as a `messages` array (system/user/assistant) so that
// train.py can apply the model's native chat template via
// tokenizer.apply_chat_template(), ensuring the token sequences during training
// exactly match those produced during inference via vLLM/Ollama.
//
// Each JSONL line looks like:
// {"messages": [
//   {"role": "system",    "content": "<skill excerpt>"},
//   {"role": "user",      "content": "<trigger message>"},
//   {"role": "assistant", "content": "Thought: ...\nAction: none\nObservation: none\nResponse: <reply>"}
// ]}

export async function generateReActDataset(
  tweetsByAccount: Record<string, string[]>,
  skill: string,
  geminiModel: string,
  gatewayConfig: GatewayConfig,
  grokApiKey?: string
): Promise<string> {
  const skillExcerpt = skill.length > SKILL_EXCERPT_CHARS
    ? skill.slice(0, SKILL_EXCERPT_CHARS) + '\n...(truncated)'
    : skill;

  const blocks = Object.entries(tweetsByAccount)
    .map(([u, tweets]) => {
      const limited = tweets.slice(0, MAX_TWEETS_PER_ACCOUNT);
      return `### @${u}\n${limited.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
    })
    .join('\n\n');

  const prompt = `You are generating a fine-tuning dataset for an AI agent.
Output ${TRAJECTORIES_PER_CALL} training examples based on the persona's skill and raw tweets.

Each example MUST be a single JSON object on one line with a "messages" field:
{"messages": [{"role": "system", "content": "<SKILL_EXCERPT>"}, {"role": "user", "content": "<TRIGGER>"}, {"role": "assistant", "content": "Thought: <reasoning>\\nAction: none\\nObservation: none\\nResponse: <reply>"}]}

Where:
- "system" content = the EXACT skill excerpt below (copy it verbatim, do not summarise)
- "user" content = a realistic trigger message someone might send to this persona
- "assistant" content = the agent's ReAct reasoning chain ending with Response:

CRITICAL RULES:
1. Output ONLY the ${TRAJECTORIES_PER_CALL} JSON lines. No explanations, no numbering, no markdown.
2. Every line must be parseable by JSON.parse().
3. Use \\n (two characters: backslash + n) inside JSON strings for newlines.
4. At least 2 of the ${TRAJECTORIES_PER_CALL} scenarios must end with "Response: <skip>" — this persona rarely replies.
5. The system content must be the verbatim skill excerpt, not a summary.
6. Replies must be ≤280 characters and match the persona's voice and language.

Persona Skill (use this VERBATIM as the system field):
${skillExcerpt}

Raw Tweets (use for voice/topic inspiration):
${blocks}

Output exactly ${TRAJECTORIES_PER_CALL} lines of valid JSONL now:`;

  const output = await fetchLLM(
    geminiModel,
    [{ role: 'user', parts: [{ text: prompt }] }],
    undefined,
    { maxOutputTokens: 4000, temperature: 0.7 },
    gatewayConfig,
    grokApiKey
  );

  const cleaned = output.replace(/```jsonl?|```/g, '').trim();

  // Validate line-by-line — keep only valid JSON with a non-empty messages array
  // where the assistant turn contains a valid ReAct Response: line.
  const validLines = cleaned
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('{'))
    .filter(l => {
      try {
        const parsed = JSON.parse(l);
        if (!Array.isArray(parsed.messages) || parsed.messages.length < 2) return false;
        const assistant = parsed.messages.find((m: any) => m.role === 'assistant');
        if (!assistant || typeof assistant.content !== 'string') return false;
        // Must contain a Response: marker
        return assistant.content.includes('Response:');
      } catch {
        return false;
      }
    });

  if (validLines.length === 0) {
    throw new Error(
      `Dataset generation produced no valid JSONL lines. Raw output snippet:\n${cleaned.slice(0, 400)}`
    );
  }

  return validLines.join('\n');
}
