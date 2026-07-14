import type { Page } from "playwright";
import type { ModelsConfig } from "../config/loader.js";
import { locateElement, validateExpectation } from "../agents/vision.js";
import type { AttemptLog, PlannedAction, RecoveryStrategy, StepResult } from "../agents/types.js";

export interface ExecutorContext {
  page: Page;
  models: ModelsConfig;
  secrets: { username: string; password: string };
  product: string;
  screenshotDir: string;
  onScreenshot: (path: string, base64: string) => void;
  onReasoning: (entry: Record<string, unknown>) => void;
  verbose?: boolean;
}

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function resolveValue(value: string | undefined, ctx: ExecutorContext): string | undefined {
  if (!value) return value;
  return value
    .replace("{{username}}", ctx.secrets.username)
    .replace("{{password}}", ctx.secrets.password)
    .replace("{{product}}", ctx.product);
}

/** Never let a secret leak into the reasoning log or console output. */
function redact(value: string | undefined, ctx: ExecutorContext): string | undefined {
  if (!value) return value;
  return value
    .replaceAll(ctx.secrets.password, "********")
    .replaceAll(ctx.secrets.username, "{{username}}");
}

async function screenshotBase64(ctx: ExecutorContext, tag: string): Promise<{ base64: string; path: string }> {
  // Best-effort settle wait before every screenshot: page.goto only waits for
  // "domcontentloaded", which fires before a JS-rendered storefront (React/
  // Angular-style SPA) has actually painted its content, so a screenshot taken
  // immediately after navigation (or after a client-side route change from a
  // click) can be genuinely blank. Waiting for network idle catches most of
  // that without blocking indefinitely on sites with persistent polling/websockets.
  await ctx.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  const buf = await ctx.page.screenshot();
  const base64 = buf.toString("base64");
  const filePath = `${ctx.screenshotDir}/${Date.now()}-${tag}.png`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, buf);
  ctx.onScreenshot(filePath, base64);
  return { base64, path: filePath };
}

async function tryFreshScreenshot(
  action: PlannedAction,
  ctx: ExecutorContext,
): Promise<AttemptLog & { locator?: import("playwright").Locator }> {
  const { base64 } = await screenshotBase64(ctx, "locate");
  const result = await locateElement(action.target ?? action.step, { models: ctx.models, screenshotBase64: base64, verbose: ctx.verbose });
  if (!result.found || !result.role || !result.label) {
    return {
      strategy: "fresh_screenshot",
      reasoning: result.reasoning,
      confidence: result.confidence,
      success: false,
      error: "Vision agent did not confidently locate the element",
    };
  }
  try {
    const locator = ctx.page.getByRole(result.role as never, { name: result.label, exact: false }).first();
    await locator.waitFor({ state: "visible", timeout: 5000 });
    return {
      strategy: "fresh_screenshot",
      reasoning: result.reasoning,
      confidence: result.confidence,
      success: true,
      locator,
    };
  } catch (e) {
    return {
      strategy: "fresh_screenshot",
      reasoning: result.reasoning,
      confidence: result.confidence,
      success: false,
      error: (e as Error).message,
    };
  }
}

/**
 * Walks the live DOM's interactive elements and scores each one's accessible
 * name (aria-label, label text, placeholder, visible text) against the
 * target description — a DOM-level stand-in for an accessibility-tree query,
 * independent of the Vision Agent's screenshot-based reasoning.
 */
async function tryAccessibilityTree(
  action: PlannedAction,
  ctx: ExecutorContext,
): Promise<AttemptLog & { locator?: import("playwright").Locator }> {
  try {
    const target = (action.target ?? action.step).toLowerCase();
    const words = target.split(/\W+/).filter((w) => w.length > 3);

    const best = await ctx.page.evaluate((words: string[]) => {
      document.querySelectorAll("[data-aiqa-recovery]").forEach((el) => el.removeAttribute("data-aiqa-recovery"));
      const els = Array.from(
        document.querySelectorAll<HTMLElement>(
          "input, button, a, select, textarea, [role], [tabindex]",
        ),
      );
      let bestScore = 0;
      let bestEl: HTMLElement | null = null;
      let bestName = "";
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const name = (
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          (el as HTMLInputElement).value ||
          el.textContent ||
          ""
        )
          .trim()
          .toLowerCase();
        if (!name) continue;
        const score = words.reduce((acc, w) => acc + (name.includes(w) ? 1 : 0), 0);
        if (score > bestScore) {
          bestScore = score;
          bestEl = el;
          bestName = name;
        }
      }
      if (!bestEl || bestScore === 0) return null;
      bestEl.setAttribute("data-aiqa-recovery", "1");
      return { name: bestName, tag: bestEl.tagName.toLowerCase() };
    }, words);

    if (!best) {
      return { strategy: "accessibility_tree", reasoning: "No DOM element matched target description", success: false };
    }

    const locator = ctx.page.locator('[data-aiqa-recovery="1"]').first();
    await locator.waitFor({ state: "visible", timeout: 5000 });
    return {
      strategy: "accessibility_tree",
      reasoning: `Matched DOM element <${best.tag}> with accessible name "${best.name}"`,
      success: true,
      locator,
    };
  } catch (e) {
    return { strategy: "accessibility_tree", reasoning: "DOM accessibility scan failed", success: false, error: (e as Error).message };
  }
}

async function tryDomLocator(
  action: PlannedAction,
  ctx: ExecutorContext,
): Promise<AttemptLog & { locator?: import("playwright").Locator }> {
  const desc = action.target ?? action.step;
  const candidates: import("playwright").Locator[] = [
    ctx.page.getByPlaceholder(new RegExp(desc.split(" ").slice(-2).join("|"), "i")),
    ctx.page.getByLabel(new RegExp(desc, "i")),
    ctx.page.getByText(new RegExp(desc, "i")).first(),
  ];
  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout: 2000 });
      return { strategy: "dom_locator", reasoning: `Matched via heuristic DOM locator for "${desc}"`, success: true, locator };
    } catch {
      // try next candidate
    }
  }
  return { strategy: "dom_locator", reasoning: `No DOM heuristic matched "${desc}"`, success: false };
}

async function tryCoordinates(action: PlannedAction, ctx: ExecutorContext): Promise<AttemptLog> {
  const { base64 } = await screenshotBase64(ctx, "coords");
  const result = await locateElement(
    `${action.target ?? action.step} — respond with approximate normalized coordinates 0-1 in a "coordinates" field {x,y}`,
    { models: ctx.models, screenshotBase64: base64, verbose: ctx.verbose },
  );
  if (!result.coordinates) {
    return { strategy: "coordinates", reasoning: "Vision agent returned no coordinates", success: false };
  }
  const viewport = ctx.page.viewportSize() ?? { width: 1280, height: 720 };
  const x = result.coordinates.x <= 1 ? result.coordinates.x * viewport.width : result.coordinates.x;
  const y = result.coordinates.y <= 1 ? result.coordinates.y * viewport.height : result.coordinates.y;
  try {
    await ctx.page.mouse.click(x, y);
    return { strategy: "coordinates", reasoning: `Clicked fallback coordinates (${x}, ${y})`, confidence: result.confidence, success: true };
  } catch (e) {
    return { strategy: "coordinates", reasoning: "Coordinate click failed", success: false, error: (e as Error).message };
  }
}

async function tryAlternateWorkflow(action: PlannedAction, ctx: ExecutorContext): Promise<AttemptLog> {
  try {
    if (action.intent === "type") {
      await ctx.page.keyboard.press("Tab");
      await ctx.page.keyboard.type(resolveValue(action.value, ctx) ?? "");
      return { strategy: "alternate_workflow", reasoning: "Tabbed to next field and typed as last resort", success: true };
    }
    if (action.intent === "click") {
      await ctx.page.keyboard.press("Enter");
      return { strategy: "alternate_workflow", reasoning: "Pressed Enter as a substitute for clicking", success: true };
    }
    return { strategy: "alternate_workflow", reasoning: "No alternate workflow available for this intent", success: false };
  } catch (e) {
    return { strategy: "alternate_workflow", reasoning: "Alternate workflow failed", success: false, error: (e as Error).message };
  }
}

/**
 * Executes one planned action against the live page. Playwright only ever
 * performs mechanical actions here (click/type/scroll/select/navigate/upload) —
 * all "what does this mean" reasoning already happened in the Planner Agent,
 * and all "where is it on screen" reasoning happens via the Vision Agent.
 * On failure, walks the 5-step recovery ladder from the spec before giving up.
 */
export async function executeAction(action: PlannedAction, ctx: ExecutorContext): Promise<StepResult> {
  const start = Date.now();
  const attempts: AttemptLog[] = [];

  if (action.intent === "navigate") {
    const url = resolveValue(action.value ?? action.target, ctx) ?? "";
    if (isAbsoluteUrl(url)) {
      await ctx.page.goto(url, { waitUntil: "domcontentloaded" });
      const { path } = await screenshotBase64(ctx, "navigate");
      attempts.push({ strategy: "fresh_screenshot", reasoning: `Navigated to ${url}`, success: true });
      ctx.onReasoning({ action: action.step, intent: action.intent, reasoning: attempts[0].reasoning });
      return { action, status: "passed", attempts, screenshotPath: path, durationMs: Date.now() - start };
    }
    // The planner emitted "navigate" without a real URL (e.g. a page
    // description like "product list page"). Treat it as a click on that
    // description instead of crashing — this is exactly what the
    // recovery ladder below is for.
    attempts.push({
      strategy: "fresh_screenshot",
      reasoning: `"navigate" target "${url}" is not an absolute URL; falling back to click-based recovery`,
      success: false,
    });
    action = { ...action, intent: "click" };
  }

  if (action.intent === "wait") {
    await ctx.page.waitForLoadState("networkidle").catch(() => undefined);
    const { path } = await screenshotBase64(ctx, "wait");
    attempts.push({ strategy: "fresh_screenshot", reasoning: "Waited for network idle", success: true });
    return { action, status: "passed", attempts, screenshotPath: path, durationMs: Date.now() - start };
  }

  if (action.intent === "verify") {
    const { base64, path } = await screenshotBase64(ctx, "verify");
    const result = await validateExpectation(action.expected ?? "", action.verifications ?? [], {
      models: ctx.models,
      screenshotBase64: base64,
      verbose: ctx.verbose,
    });
    attempts.push({
      strategy: "fresh_screenshot",
      reasoning: result.reasoning,
      confidence: result.confidence,
      success: result.passed,
      error: result.passed ? undefined : (result.failedChecks ?? []).join("; "),
    });
    ctx.onReasoning({
      action: action.step,
      intent: action.intent,
      passed: result.passed,
      confidence: result.confidence,
      reasoning: result.reasoning,
      extractedValues: result.extractedValues,
    });
    return {
      action,
      status: result.passed ? "passed" : "failed",
      attempts,
      screenshotPath: path,
      durationMs: Date.now() - start,
    };
  }

  // click / type / select / scroll / upload: walk the recovery ladder.
  const strategies: Array<(a: PlannedAction, c: ExecutorContext) => Promise<AttemptLog & { locator?: import("playwright").Locator }>> = [
    tryFreshScreenshot,
    tryAccessibilityTree,
    tryDomLocator,
  ];

  let locator: import("playwright").Locator | undefined;
  for (const strategy of strategies) {
    const attempt = await strategy(action, ctx);
    attempts.push({ ...attempt, reasoning: redact(attempt.reasoning, ctx) ?? attempt.reasoning });
    ctx.onReasoning({ action: action.step, intent: action.intent, ...attempt, reasoning: redact(attempt.reasoning, ctx) });
    if (attempt.success && attempt.locator) {
      locator = attempt.locator;
      break;
    }
  }

  let performed = false;
  let performError: string | undefined;

  if (locator) {
    try {
      if (action.intent === "click") await locator.click({ timeout: 5000 });
      else if (action.intent === "type") await locator.fill(resolveValue(action.value, ctx) ?? "");
      else if (action.intent === "select") await locator.selectOption({ label: resolveValue(action.value, ctx) ?? "" });
      else if (action.intent === "scroll") await locator.scrollIntoViewIfNeeded();
      else if (action.intent === "upload") await locator.setInputFiles(resolveValue(action.value, ctx) ?? "");
      performed = true;
    } catch (e) {
      performError = (e as Error).message;
      attempts.push({ strategy: "dom_locator", reasoning: `Located element but action failed: ${performError}`, success: false, error: performError });
    }
  }

  if (!performed) {
    const coordAttempt = await tryCoordinates(action, ctx);
    attempts.push(coordAttempt);
    ctx.onReasoning({ action: action.step, intent: action.intent, ...coordAttempt });
    performed = coordAttempt.success;

    if (!performed) {
      const altAttempt = await tryAlternateWorkflow(action, ctx);
      attempts.push({ ...altAttempt, reasoning: redact(altAttempt.reasoning, ctx) ?? altAttempt.reasoning });
      ctx.onReasoning({ action: action.step, intent: action.intent, ...altAttempt });
      performed = altAttempt.success;
    }
  }

  const { path } = await screenshotBase64(ctx, "result");

  if (!performed) {
    return {
      action,
      status: "failed",
      attempts,
      screenshotPath: path,
      durationMs: Date.now() - start,
    };
  }

  return { action, status: "passed", attempts, screenshotPath: path, durationMs: Date.now() - start };
}
