#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { chromium } from "playwright";
import { loadModelsConfig, resolveCredentials, resolveProduct, resolveSite } from "../config/loader.js";
import { parseNlp } from "../agents/nlp-parser.js";
import { generatePlan } from "../agents/planner.js";
import { loadCachedPlan, saveCachedPlan } from "../agents/plan-cache.js";
import { executeAction } from "../executor/action-executor.js";
import { appendReasoning, createRunPaths, writePlan, writeReport, writeStatus } from "../reporter/reporter.js";
import { startLiveServer, type LiveStatus, type LiveStep } from "../reporter/live-server.js";
import type { ExecutionPlan, StepResult } from "../agents/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const TESTS_DIR = path.join(REPO_ROOT, "tests");
const RUNS_DIR = path.join(REPO_ROOT, "runs");

const program = new Command();
program
  .name("aiqa")
  .description("AI-native testing platform — reads NLP scenarios, generates and executes plans at runtime")
  .requiredOption("--env <env>", "environment: dev | stg | prd")
  .requiredOption("--site <site>", 'site id, or "all" to run every site in the environment')
  .requiredOption("--scenario <scenario>", "scenario name, matches tests/{env}/{site}/{scenario}.nlp")
  .option("--planner-model <model>", "override the planner model for this run")
  .option("--vision-model <model>", "override the vision model for this run")
  .option("--headed", "run the browser headed instead of headless", false)
  .option("--live-port <port>", "port for the live execution viewer", "4180")
  .option("--no-live", "disable the live execution viewer")
  .option("--verbose", "print every Ollama request/response (system prompt, prompt, image count, raw response) live", false)
  .option("--no-plan-cache", "always regenerate the plan, even if the .nlp file is unchanged since last time")
  .parse(process.argv);

const opts = program.opts<{
  env: string;
  site: string;
  scenario: string;
  plannerModel?: string;
  visionModel?: string;
  headed: boolean;
  livePort: string;
  live: boolean;
  verbose: boolean;
  planCache: boolean;
}>();

async function runOne(env: string, site: string, scenario: string): Promise<boolean> {
  console.log(`\n=== aiqa run --env ${env} --site ${site} --scenario ${scenario} ===`);

  const models = await loadModelsConfig({ plannerModel: opts.plannerModel, visionModel: opts.visionModel });
  console.log(`planner model: ${models.planner.model} | vision model: ${models.vision.model}`);

  const nlpFile = path.join(TESTS_DIR, env, site, `${scenario}.nlp`);
  const nlpSource = await readFile(nlpFile, "utf-8");
  const scenarioDef = parseNlp(nlpSource, nlpFile);

  const [{ baseUrl }, product, secrets] = await Promise.all([
    resolveSite(env, site),
    resolveProduct(env, site),
    resolveCredentials(env, site),
  ]);

  console.log(`Reading NLP scenario: ${nlpFile}`);

  const cacheKey = { nlpSource, baseUrl, plannerModel: models.planner.model };
  const cachedPlan = opts.planCache ? await loadCachedPlan(env, site, scenario, cacheKey) : undefined;

  let plan: ExecutionPlan;
  if (cachedPlan) {
    plan = cachedPlan;
    console.log(
      `Using cached execution plan — .nlp file unchanged since it was last planned (${plan.actions.length} actions). Pass --no-plan-cache to force regeneration.`,
    );
  } else {
    console.log(`Generating execution plan at runtime via ${models.planner.model} ...`);
    plan = await generatePlan(scenarioDef, {
      baseUrl,
      models,
      verbose: opts.verbose,
      onStepPlanned: ({ index, total, step, durationMs }) => {
        console.log(`  [plan ${index}/${total}] (${(durationMs / 1000).toFixed(1)}s) ${step}`);
      },
    });
    console.log(`Execution plan generated: ${plan.actions.length} actions`);
    if (opts.planCache) await saveCachedPlan(env, site, scenario, cacheKey, plan);
  }

  const paths = await createRunPaths(RUNS_DIR, `${site}-${scenario}`);
  await writePlan(paths, plan);
  console.log(`Run artifacts: ${paths.runDir}`);
  console.log(`Generated plan: ${paths.planPath}`);

  const startedAt = new Date().toISOString();
  const liveStatus: LiveStatus = {
    runId: paths.runId,
    environment: env,
    site,
    scenario,
    baseUrl,
    plannerModel: models.planner.model,
    visionModel: models.vision.model,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    steps: [],
  };
  await writeStatus(paths, liveStatus);

  let live: { url: string; close: () => void } | undefined;
  if (opts.live) {
    live = startLiveServer(paths, Number(opts.livePort));
    console.log(`Live viewer: ${live.url}  (current step, screenshot, AI reasoning, confidence — updates as it runs)`);
  }

  const browser = await chromium.launch({ headless: !opts.headed });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const results: StepResult[] = [];

  try {
    for (const [index, action] of plan.actions.entries()) {
      const label = `[${index + 1}/${plan.actions.length}]`;
      process.stdout.write(`${label} ${action.intent.padEnd(8)} ${action.step}\n`);

      const result = await executeAction(action, {
        page,
        models,
        secrets,
        product,
        screenshotDir: paths.screenshotsDir,
        onScreenshot: () => {},
        onReasoning: (entry) => {
          void appendReasoning(paths, entry);
        },
        verbose: opts.verbose,
      });

      results.push(result);
      const icon = result.status === "passed" ? "PASS" : "FAIL";
      const lastAttempt = result.attempts[result.attempts.length - 1];
      console.log(
        `      -> ${icon} (${result.durationMs}ms) confidence=${lastAttempt?.confidence ?? "-"} ${lastAttempt?.reasoning ?? ""}`,
      );

      if (result.status === "failed" && action.intent !== "verify") {
        console.log(`      Recovery ladder exhausted for this step; continuing scenario to gather full report.`);
      }

      const liveStep: LiveStep = {
        index: index + 1,
        total: plan.actions.length,
        step: action.step,
        intent: action.intent,
        target: action.target,
        expected: action.expected,
        status: result.status,
        confidence: lastAttempt?.confidence ?? "-",
        reasoning: lastAttempt?.reasoning,
        screenshot: result.screenshotPath ? result.screenshotPath.split("/").pop() : undefined,
        durationMs: result.durationMs,
      };
      liveStatus.steps.push(liveStep);
      liveStatus.updatedAt = new Date().toISOString();
      await writeStatus(paths, liveStatus);
    }
  } finally {
    await browser.close();
  }

  await writeReport(paths, plan, results, startedAt);

  const failed = results.filter((r) => r.status === "failed").length;
  liveStatus.status = failed === 0 ? "passed" : "failed";
  liveStatus.updatedAt = new Date().toISOString();
  await writeStatus(paths, liveStatus);

  console.log(`\n${failed === 0 ? "PASSED" : "FAILED"} — ${results.length - failed}/${results.length} steps passed`);
  console.log(`Report:  ${paths.reportPath}`);
  console.log(`Replay:  ${paths.htmlDir}/index.html`);
  live?.close();
  return failed === 0;
}

async function main() {
  let sites: string[];
  if (opts.site === "all") {
    sites = (await readdir(path.join(TESTS_DIR, opts.env), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } else {
    sites = [opts.site];
  }

  let allPassed = true;
  for (const site of sites) {
    const ok = await runOne(opts.env, site, opts.scenario);
    allPassed = allPassed && ok;
  }
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("aiqa run failed:", err);
  process.exit(1);
});
