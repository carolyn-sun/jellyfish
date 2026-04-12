// ─── Cloudflare AI Gateway → Google AI Studio REST client ──────────────────
// Using direct fetch instead of ai-gateway-provider (which is incompatible with ai@6).
// Reference: https://developers.cloudflare.com/ai-gateway/providers/google-ai-studio/
// Endpoint: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/google-ai-studio/v1beta/models/{model}:generateContent

// ─── Cloudflare AI Gateway → xAI (Grok) REST client ───────────────────────
// Reference: https://developers.cloudflare.com/ai-gateway/providers/xai/
// Endpoint: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/xai/v1/chat/completions

export interface GeminiContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

interface GeminiConfig {
  maxOutputTokens?: number;
  temperature?: number;
}

interface GatewayConfig {
  accountId: string;
  gateway: string;
  apiKey: string; // CF AI Gateway token (cf-aig-authorization)
}

// ─── Gemini (Google AI Studio via CF AI Gateway) ──────────────────────────────
export async function fetchGemini(
  model: string,
  contents: GeminiContent[],
  systemInstruction?: string,
  config?: GeminiConfig,
  _legacyApiKey?: string,     // kept for signature compatibility, unused
  _legacyGatewayUrl?: string, // kept for signature compatibility, unused
  gatewayConfig?: GatewayConfig,
): Promise<string> {
  if (!gatewayConfig) {
    throw new Error('[gemini] gatewayConfig (accountId, gateway, apiKey) is required');
  }

  // Strip optional "google/" prefix if caller added it
  const modelId = model.startsWith('google/') ? model.slice('google/'.length) : model;

  const url = `https://gateway.ai.cloudflare.com/v1/${gatewayConfig.accountId}/${gatewayConfig.gateway}/google-ai-studio/v1beta/models/${modelId}:generateContent`;

  const body: Record<string, unknown> = { contents };

  if (systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  if (config?.maxOutputTokens !== undefined || config?.temperature !== undefined) {
    const genConfig: Record<string, unknown> = {};
    if (config.maxOutputTokens !== undefined) genConfig.maxOutputTokens = config.maxOutputTokens;
    if (config.temperature !== undefined) genConfig.temperature = config.temperature;
    body.generationConfig = genConfig;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cf-aig-authorization': `Bearer ${gatewayConfig.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '(no body)');
    throw new Error(`[gemini] API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string; safetyRatings?: unknown[] };
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`[gemini] API returned error: ${data.error.message}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const finishReason = data.candidates?.[0]?.finishReason ?? 'no candidates';
    const blockReason = data.promptFeedback?.blockReason ?? 'none';
    console.error('[gemini] Empty response. finishReason:', finishReason, '| blockReason:', blockReason, '| full:', JSON.stringify(data).slice(0, 500));
    throw new Error(`[gemini] Empty response from model (finishReason: ${finishReason}, blockReason: ${blockReason})`);
  }
  return text.trim();
}

// ─── Grok (xAI via CF AI Gateway) ────────────────────────────────────────────
// Uses OpenAI-compatible /chat/completions endpoint.
// GeminiContent role:'model' is mapped to role:'assistant' for the OpenAI wire format.
export async function fetchGrok(
  model: string,
  contents: GeminiContent[],
  systemInstruction?: string,
  config?: GeminiConfig,
  gatewayConfig?: GatewayConfig,
  grokApiKey?: string,
): Promise<string> {
  if (!gatewayConfig) {
    throw new Error('[grok] gatewayConfig (accountId, gateway, apiKey) is required');
  }
  if (!grokApiKey) {
    throw new Error('[grok] GROK_API_KEY is required when using a grok-* model');
  }

  // Strip optional "xai/" prefix
  const modelId = model.startsWith('xai/') ? model.slice('xai/'.length) : model;

  const url = `https://gateway.ai.cloudflare.com/v1/${gatewayConfig.accountId}/${gatewayConfig.gateway}/xai/v1/chat/completions`;

  // Map GeminiContent → OpenAI messages, inject system prompt first
  const messages: Array<{ role: string; content: string }> = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  for (const c of contents) {
    messages.push({
      role: c.role === 'model' ? 'assistant' : 'user',
      content: c.parts.map(p => p.text).join('\n'),
    });
  }

  const body: Record<string, unknown> = { model: modelId, messages };
  if (config?.maxOutputTokens !== undefined) body.max_tokens = config.maxOutputTokens;
  if (config?.temperature !== undefined) body.temperature = config.temperature;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${grokApiKey}`,
      'cf-aig-authorization': `Bearer ${gatewayConfig.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '(no body)');
    throw new Error(`[grok] API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`[grok] API returned error: ${data.error.message}`);
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    const finishReason = data.choices?.[0]?.finish_reason ?? 'no choices';
    console.error('[grok] Empty response. finishReason:', finishReason, '| full:', JSON.stringify(data).slice(0, 500));
    throw new Error(`[grok] Empty response from model (finishReason: ${finishReason})`);
  }
  return text.trim();
}

// ─── Unified LLM entry point ──────────────────────────────────────────────────
// Routes to Grok if the model name starts with "grok-" or "xai/", otherwise Gemini.
// The GEMINI_MODEL env var selects the active model; no code changes needed to switch.
export async function fetchLLM(
  model: string,
  contents: GeminiContent[],
  systemInstruction?: string,
  config?: GeminiConfig,
  gatewayConfig?: GatewayConfig,
  grokApiKey?: string,
): Promise<string> {
  const isGrok = model.startsWith('grok-') || model.startsWith('xai/');
  if (isGrok) {
    return fetchGrok(model, contents, systemInstruction, config, gatewayConfig, grokApiKey);
  }
  return fetchGemini(model, contents, systemInstruction, config, undefined, undefined, gatewayConfig);
}

// listGeminiModels: returns a curated list of recommended models for the Wizard UI
export async function listGeminiModels(_apiKey?: string, _gatewayUrl?: string): Promise<string[]> {
  return [
    // ── Gemini (Google AI Studio) ─────────────────────────────────────────
    'gemini-3.1-pro-preview',
    'gemini-2.0-flash',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    // ── Grok (xAI) — requires GROK_API_KEY ───────────────────────────────
    'grok-3',
    'grok-3-fast',
    'grok-3-mini',
    'grok-3-mini-fast',
  ];
}
