export interface GeminiContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

export async function fetchGemini(
  model: string,
  contents: GeminiContent[],
  systemInstruction?: string,
  config?: { maxOutputTokens?: number; temperature?: number },
  apiKey?: string,
  gatewayUrl?: string
): Promise<string> {
  const base = gatewayUrl || "https://generativelanguage.googleapis.com/v1beta";
  const urlPath = base.endsWith('/v1beta') ? base : `${base.replace(/\/+$/, '')}/v1beta`;
  const endpoint = `${urlPath}/models/${model}:generateContent`;
  
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-goog-api-key'] = apiKey;

  const payload: any = { contents };
  if (systemInstruction) payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (config) payload.generationConfig = config;

  const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from model');
  return text.trim();
}

export async function listGeminiModels(apiKey?: string, gatewayUrl?: string): Promise<string[]> {
  const base = gatewayUrl || "https://generativelanguage.googleapis.com/v1beta";
  const urlPath = base.endsWith('/v1beta') ? base : `${base.replace(/\/+$/, '')}/v1beta`;
  const endpoint = `${urlPath}/models`;

  const headers: Record<string, string> = {};
  if (apiKey) headers['x-goog-api-key'] = apiKey;

  const res = await fetch(endpoint, { headers });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return (data.models || []).map((m: any) => m.name.replace('models/', '') as string);
}
