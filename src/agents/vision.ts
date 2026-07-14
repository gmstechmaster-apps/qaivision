import type { ModelsConfig } from "../config/loader.js";
import { extractJson, ollamaGenerate } from "./ollama-client.js";
import type { VisionLocateResult, VisionValidateResult } from "./types.js";

const LOCATE_SYSTEM = `You are the Vision Agent in an AI QA platform. You are shown a screenshot of a
web page and a description of a UI element to find. Respond with ONLY a JSON object:
{"found": boolean, "elementType": string, "role": string, "label": string, "confidence": number (0-1), "reasoning": string}
"role" should be an ARIA-ish role such as "textbox", "button", "link", "combobox", "checkbox".
"label" should be the visible accessible name/text of the element, suitable for locating it by
its on-screen label. If you cannot find the element, set "found": false and explain why in "reasoning".`;

const VALIDATE_SYSTEM = `You are the Vision Agent in an AI QA platform. You are shown a screenshot of a
web page after an action was performed. Verify whether the expected result is true, and/or
extract requested business data (e.g. price, product name, order number). Respond with ONLY a
JSON object:
{"passed": boolean, "confidence": number (0-1), "reasoning": string, "extractedValues": object|null, "failedChecks": string[]|null}
"extractedValues" should map each requested field name to the value you read from the screenshot.
"failedChecks" should list which specific checks did not pass, if any.`;

interface VisionCallCtx {
  models: ModelsConfig;
  screenshotBase64: string;
}

export async function locateElement(
  targetDescription: string,
  ctx: VisionCallCtx,
): Promise<VisionLocateResult> {
  const { json } = await ollamaGenerate({
    host: ctx.models.ollama.host,
    model: ctx.models.vision.model,
    system: LOCATE_SYSTEM,
    prompt: `Locate this element: "${targetDescription}"`,
    images: [ctx.screenshotBase64],
    temperature: ctx.models.vision.temperature,
    timeoutMs: ctx.models.ollama.requestTimeoutMs,
    json: true,
  });

  const parsed = json as Partial<VisionLocateResult> | undefined;
  return {
    found: parsed?.found ?? false,
    elementType: parsed?.elementType,
    role: parsed?.role,
    label: parsed?.label,
    confidence: typeof parsed?.confidence === "number" ? parsed.confidence : 0,
    reasoning: parsed?.reasoning ?? "Vision model returned no usable response.",
    coordinates: parsed?.coordinates,
  };
}

export async function validateExpectation(
  expected: string,
  checks: string[],
  ctx: VisionCallCtx,
): Promise<VisionValidateResult> {
  const checksText = checks.length > 0 ? `\nSpecific checks:\n${checks.map((c) => `- ${c}`).join("\n")}` : "";
  const { json, raw } = await ollamaGenerate({
    host: ctx.models.ollama.host,
    model: ctx.models.vision.model,
    system: VALIDATE_SYSTEM,
    prompt: `Expected result: "${expected}"${checksText}`,
    images: [ctx.screenshotBase64],
    temperature: ctx.models.vision.temperature,
    timeoutMs: ctx.models.ollama.requestTimeoutMs,
    json: true,
  });

  const parsed = (json ?? extractJson(raw)) as Partial<VisionValidateResult> | undefined;
  return {
    passed: parsed?.passed ?? false,
    confidence: typeof parsed?.confidence === "number" ? parsed.confidence : 0,
    reasoning: parsed?.reasoning ?? "Vision model returned no usable response.",
    extractedValues: parsed?.extractedValues,
    failedChecks: parsed?.failedChecks,
  };
}
