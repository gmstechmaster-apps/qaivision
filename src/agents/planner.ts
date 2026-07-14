import type { ModelsConfig } from "../config/loader.js";
import type { NlpScenario, NlpStep } from "./nlp-parser.js";
import { ollamaGenerate } from "./ollama-client.js";
import type { ActionIntent, ExecutionPlan, PlannedAction } from "./types.js";

/**
 * Bump this whenever planStep's logic changes in a way that would produce a
 * different plan for the same .nlp text (new special-case, prompt/few-shot
 * change, etc.). It's folded into the plan cache's hash key so a qaivision
 * code update always invalidates old cached plans, even when the .nlp file,
 * baseUrl, and planner model are all unchanged — a code fix can never be
 * silently masked by a stale cache entry.
 */
export const PLANNER_LOGIC_VERSION = 2;

const SYSTEM_PROMPT = `You are the Planner Agent in an AI QA platform for e-commerce storefronts.
You convert ONE natural-language QA instruction into a JSON array of atomic browser actions.

Allowed intents: navigate, click, type, select, scroll, upload, verify, wait.

Rules:
- Output ONLY a JSON array, no prose, no markdown fences.
- Each action: {"intent": string, "target": string, "value": string|null, "expected": string, "verifications": string[]|null}
- "target" is a short human description of the UI element (e.g. "search input field", "Add to Cart button"), never a CSS selector.
- Only use "navigate" when you have a real absolute URL for "value" (e.g. an already-known page URL). NEVER use "navigate" to move between pages by guessing a URL. To open a product, go to cart/checkout, or otherwise move around by clicking a link or button, use "click" with a "target" description instead — the page transition happens as a side effect of the click.
- For login username/password, use "value": "{{username}}" or "{{password}}" — never invent credentials.
- For the product under test, use "value": "{{product}}".
- For "verify" intents, put the requested checks in "verifications" and leave "target"/"value" null.
- Keep the action list minimal but complete: only what's needed to perform the instruction.
- "expected" describes what should be observably true after the action (used to validate via screenshot).`;

const FEW_SHOT = `Example instruction: "Search for the configured product."
Example output:
[
  {"intent":"click","target":"search input field","value":null,"expected":"Search field is focused","verifications":null},
  {"intent":"type","target":"search input field","value":"{{product}}","expected":"Search field contains the product name","verifications":null},
  {"intent":"click","target":"search submit button or magnifier icon","value":null,"expected":"Search results page is shown","verifications":null}
]

Example instruction: "Open the first purchasable product."
Example output:
[
  {"intent":"click","target":"first in-stock product in the results list","value":null,"expected":"Product detail page is shown","verifications":null}
]

Example instruction: "Add product to cart."
Example output:
[
  {"intent":"click","target":"Add to Cart button","value":null,"expected":"Product is added and cart reflects the new item","verifications":null}
]`;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `a${counter}`;
}

async function planStep(
  step: NlpStep,
  ctx: { baseUrl: string; models: ModelsConfig; verbose?: boolean },
): Promise<PlannedAction[]> {
  if (step.text === "Verify" && step.verifications) {
    return [
      {
        id: nextId(),
        step: `Verify: ${step.verifications.join(", ")}`,
        intent: "verify",
        expected: step.verifications.join("; "),
        verifications: step.verifications,
        retries: 2,
      },
    ];
  }

  // Login is handled deterministically rather than through the LLM: the
  // login page is always at {baseUrl}/login, so there's nothing for the
  // model to figure out here, and skipping the call saves time and removes
  // a source of guesswork (e.g. clicking the wrong "login" link) on a very
  // common, well-defined step.
  if (/\blog[\s-]?in\b/i.test(step.text)) {
    const loginUrl = new URL("/login", ctx.baseUrl).toString();
    return [
      {
        id: nextId(),
        step: step.text,
        intent: "navigate",
        target: loginUrl,
        value: loginUrl,
        expected: "Login form is visible",
        retries: 2,
      },
      {
        id: nextId(),
        step: step.text,
        intent: "type",
        target: "username/email field",
        value: "{{username}}",
        expected: "Username field contains the typed value",
        retries: 2,
      },
      {
        id: nextId(),
        step: step.text,
        intent: "type",
        target: "password field",
        value: "{{password}}",
        expected: "Password field contains the typed value",
        retries: 2,
      },
      {
        id: nextId(),
        step: step.text,
        intent: "click",
        target: "Login/Sign in button",
        expected: "User is logged in and account menu is visible",
        retries: 2,
      },
    ];
  }

  const prompt = `${FEW_SHOT}\n\nInstruction: "${step.text}"\nOutput:`;

  const { json } = await ollamaGenerate({
    host: ctx.models.ollama.host,
    model: ctx.models.planner.model,
    system: SYSTEM_PROMPT,
    prompt,
    temperature: ctx.models.planner.temperature,
    timeoutMs: ctx.models.ollama.requestTimeoutMs,
    json: true,
    verbose: ctx.verbose,
    label: "planner",
  });

  const parsed = normalizePlannerOutput(json);
  if (parsed.length === 0) {
    // Deterministic fallback keeps the run alive if the local model returns
    // malformed output; the instruction is still executed as a single
    // best-effort click, and the Vision Agent's own reasoning takes over.
    return [
      {
        id: nextId(),
        step: step.text,
        intent: "click",
        target: step.text,
        expected: `Effect of: ${step.text}`,
        retries: 2,
      },
    ];
  }

  return parsed.map((a) => ({ ...a, id: nextId(), step: step.text }));
}

function normalizePlannerOutput(json: unknown): Omit<PlannedAction, "id" | "step">[] {
  if (!Array.isArray(json)) return [];
  const allowed: ActionIntent[] = [
    "navigate",
    "click",
    "type",
    "select",
    "scroll",
    "upload",
    "verify",
    "wait",
  ];
  const out: Omit<PlannedAction, "id" | "step">[] = [];
  for (const entry of json) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const intent = typeof e.intent === "string" ? (e.intent as ActionIntent) : undefined;
    if (!intent || !allowed.includes(intent)) continue;
    out.push({
      intent,
      target: typeof e.target === "string" ? e.target : undefined,
      value: typeof e.value === "string" ? e.value : undefined,
      expected: typeof e.expected === "string" ? e.expected : undefined,
      verifications: Array.isArray(e.verifications)
        ? e.verifications.filter((v): v is string => typeof v === "string")
        : undefined,
      retries: 2,
    });
  }
  return out;
}

/**
 * Generates a fresh execution plan from an NLP scenario. Called on every
 * run — nothing is cached or reused across runs, so editing the .nlp file
 * changes behavior on the very next execution with no code changes.
 */
export async function generatePlan(
  scenario: NlpScenario,
  ctx: {
    baseUrl: string;
    models: ModelsConfig;
    verbose?: boolean;
    onStepPlanned?: (info: { index: number; total: number; step: string; durationMs: number }) => void;
  },
): Promise<ExecutionPlan> {
  const actions: PlannedAction[] = [
    {
      id: nextId(),
      step: "(implicit) open storefront",
      intent: "navigate",
      target: ctx.baseUrl,
      value: ctx.baseUrl,
      expected: "Homepage is loaded",
      retries: 2,
    },
  ];

  const total = scenario.steps.length;
  for (const [index, step] of scenario.steps.entries()) {
    const start = Date.now();
    const stepActions = await planStep(step, ctx);
    actions.push(...stepActions);
    ctx.onStepPlanned?.({ index: index + 1, total, step: step.text, durationMs: Date.now() - start });
  }

  return {
    environment: scenario.environment,
    site: scenario.site,
    scenario: scenario.scenario,
    baseUrl: ctx.baseUrl,
    generatedAt: new Date().toISOString(),
    plannerModel: ctx.models.planner.model,
    actions,
  };
}
