// ─── Cloudflare AI Gateway → Google AI Studio REST client ──────────────────
// Using direct fetch instead of ai-gateway-provider (which is incompatible with ai@6).
// Reference: https://developers.cloudflare.com/ai-gateway/providers/google-ai-studio/
// Endpoint: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/google-ai-studio/v1/models/{model}:generateContent

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

export async function fetchGemini(
  model: string,
  contents: GeminiContent[],
  systemInstruction?: string,
  config?: GeminiConfig,
  _legacyApiKey?: string,    // kept for signature compatibility, unused
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
    }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`[gemini] API returned error: ${data.error.message}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('[gemini] Empty response from model');
  return text.trim();
}

// listGeminiModels: returns a fixed recommended list (no enumeration needed via Gateway)
export async function listGeminiModels(_apiKey?: string, _gatewayUrl?: string): Promise<string[]> {
  return [
    'gemini-2.5-pro-preview-03-25',
    'gemini-2.0-flash',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ];
}
