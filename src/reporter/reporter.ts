import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionPlan, StepResult } from "../agents/types.js";

export interface RunPaths {
  runId: string;
  runDir: string;
  screenshotsDir: string;
  traceDir: string;
  htmlDir: string;
  reportPath: string;
  reasoningLogPath: string;
}

/** Creates the runs/{run-id}/ directory tree from spec section 13. */
export async function createRunPaths(baseDir: string, scenario: string): Promise<RunPaths> {
  const date = new Date().toISOString().slice(0, 10);
  let seq = 1;
  let runId = `run-${date}-${String(seq).padStart(3, "0")}-${scenario}`;
  let runDir = path.join(baseDir, runId);

  const { existsSync } = await import("node:fs");
  while (existsSync(runDir)) {
    seq += 1;
    runId = `run-${date}-${String(seq).padStart(3, "0")}-${scenario}`;
    runDir = path.join(baseDir, runId);
  }

  const screenshotsDir = path.join(runDir, "screenshots");
  const traceDir = path.join(runDir, "trace");
  const htmlDir = path.join(runDir, "html");
  await mkdir(screenshotsDir, { recursive: true });
  await mkdir(traceDir, { recursive: true });
  await mkdir(htmlDir, { recursive: true });

  return {
    runId,
    runDir,
    screenshotsDir,
    traceDir,
    htmlDir,
    reportPath: path.join(runDir, "report.json"),
    reasoningLogPath: path.join(runDir, "reasoning.log"),
  };
}

export async function appendReasoning(paths: RunPaths, entry: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  await appendFile(paths.reasoningLogPath, line + "\n", "utf-8");
}

export async function writeStatus(paths: RunPaths, status: unknown): Promise<void> {
  await writeFile(path.join(paths.runDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

export async function writeReport(
  paths: RunPaths,
  plan: ExecutionPlan,
  results: StepResult[],
  startedAt: string,
): Promise<void> {
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const report = {
    runId: paths.runId,
    environment: plan.environment,
    site: plan.site,
    scenario: plan.scenario,
    baseUrl: plan.baseUrl,
    plannerModel: plan.plannerModel,
    generatedAt: plan.generatedAt,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: { total: results.length, passed, failed, status: failed === 0 ? "passed" : "failed" },
    steps: results.map((r) => ({
      id: r.action.id,
      step: r.action.step,
      intent: r.action.intent,
      target: r.action.target,
      expected: r.action.expected,
      status: r.status,
      durationMs: r.durationMs,
      screenshot: r.screenshotPath ? path.relative(paths.runDir, r.screenshotPath) : undefined,
      attempts: r.attempts,
    })),
  };

  await writeFile(paths.reportPath, JSON.stringify(report, null, 2), "utf-8");
  await writeReplayHtml(paths, report);
}

async function writeReplayHtml(paths: RunPaths, report: unknown): Promise<void> {
  const html = `<!doctype html>
<html data-theme="light">
<head>
<meta charset="utf-8" />
<title>${(report as { runId: string }).runId} — replay</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0b0f14; color: #e6edf3; }
  header { padding: 16px 24px; border-bottom: 1px solid #22303c; }
  .step { display: grid; grid-template-columns: 320px 1fr; gap: 16px; padding: 16px 24px; border-bottom: 1px solid #182430; }
  .step img { max-width: 320px; border-radius: 6px; border: 1px solid #22303c; }
  .passed { color: #3fb950; }
  .failed { color: #f85149; }
  pre { white-space: pre-wrap; word-break: break-word; background: #10151b; padding: 8px; border-radius: 6px; }
</style>
</head>
<body>
<header>
  <h2>${(report as { scenario: string }).scenario} — ${(report as { runId: string }).runId}</h2>
  <div>Status: <strong class="${(report as { summary: { status: string } }).summary.status}">${(report as { summary: { status: string } }).summary.status}</strong>
    — ${(report as { summary: { passed: number; total: number } }).summary.passed}/${(report as { summary: { passed: number; total: number } }).summary.total} steps passed</div>
</header>
<div id="steps"></div>
<script>
  const report = ${JSON.stringify(report)};
  const el = document.getElementById("steps");
  for (const s of report.steps) {
    const div = document.createElement("div");
    div.className = "step";
    div.innerHTML = \`
      <div>\${s.screenshot ? \`<img src="../screenshots/\${s.screenshot.split('/').pop()}" />\` : ""}</div>
      <div>
        <div class="\${s.status}"><strong>\${s.status.toUpperCase()}</strong> — \${s.step}</div>
        <div>intent: \${s.intent} | target: \${s.target ?? "-"} | \${s.durationMs}ms</div>
        <div>expected: \${s.expected ?? "-"}</div>
        <pre>\${JSON.stringify(s.attempts, null, 2)}</pre>
      </div>\`;
    el.appendChild(div);
  }
</script>
</body>
</html>`;
  await writeFile(path.join(paths.htmlDir, "index.html"), html, "utf-8");
}
