export interface OllamaGenerateOptions {
  host: string;
  model: string;
  prompt: string;
  system?: string;
  images?: string[]; // base64-encoded, no data: prefix
  temperature?: number;
  timeoutMs?: number;
  json?: boolean;
}

export interface OllamaResult {
  raw: string;
  json: unknown | undefined;
}

/**
 * Thin wrapper around Ollama's /api/generate. Every call re-resolves the
 * model from the config that was passed in — nothing here is bound to a
 * specific model at import time, so swapping models is just a config change.
 */
export async function ollamaGenerate(opts: OllamaGenerateOptions): Promise<OllamaResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120000);

  try {
    const res = await fetch(`${opts.host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        prompt: opts.prompt,
        system: opts.system,
        images: opts.images,
        stream: false,
        // Deliberately NOT setting format:"json" here: Ollama's strict JSON
        // mode collapses these small local models onto a single object (or
        // an empty response for the vision model) instead of following the
        // array/schema shape described in the prompt. Plain generation plus
        // robust extraction below is measurably more reliable for them.
        options: { temperature: opts.temperature ?? 0.1 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama request failed (${res.status}) for model "${opts.model}": ${body}`);
    }

    const data = (await res.json()) as { response: string };
    const raw = data.response;
    let json: unknown | undefined;
    if (opts.json) {
      json = extractJson(raw);
    }
    return { raw, json };
  } finally {
    clearTimeout(timeout);
  }
}

/** Ollama's format:"json" mode usually returns clean JSON, but small local
 * models sometimes wrap it in prose or code fences — salvage what we can. */
export function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }
  const firstBrace = trimmed.search(/[[{]/);
  if (firstBrace >= 0) {
    // Match the closing bracket to the same type as the opening one —
    // models sometimes trail a stray '}' after a valid ']', or vice versa.
    const closer = trimmed[firstBrace] === "[" ? "]" : "}";
    const lastBrace = trimmed.lastIndexOf(closer);
    if (lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        // fall through
      }
    }
  }
  return undefined;
}
