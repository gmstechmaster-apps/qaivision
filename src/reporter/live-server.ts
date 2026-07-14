import express from "express";
import type { Server } from "node:http";
import type { RunPaths } from "./reporter.js";

export interface LiveStep {
  index: number;
  total: number;
  step: string;
  intent: string;
  target?: string;
  expected?: string;
  status: "running" | "passed" | "failed";
  confidence?: number | string;
  reasoning?: string;
  screenshot?: string;
  durationMs?: number;
}

export interface LiveStatus {
  runId: string;
  environment: string;
  site: string;
  scenario: string;
  baseUrl: string;
  plannerModel: string;
  visionModel: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  updatedAt: string;
  steps: LiveStep[];
}

const LIVE_HTML = `<!doctype html>
<html data-theme="dark">
<head>
<meta charset="utf-8" />
<title>aiqa — live execution</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0b0f14; color: #e6edf3; }
  header { padding: 14px 24px; border-bottom: 1px solid #22303c; display: flex; align-items: center; gap: 16px; position: sticky; top: 0; background: #0b0f14; z-index: 1; }
  header h2 { margin: 0; font-size: 1.05em; }
  .pill { padding: 3px 10px; border-radius: 12px; font-size: 0.8em; font-weight: 600; }
  .running { background: #3d2f00; color: #e3b341; }
  .passed { background: #0f2e17; color: #3fb950; }
  .failed { background: #3c1618; color: #f85149; }
  main { display: grid; grid-template-columns: 1fr 460px; gap: 0; }
  #steps { padding: 12px 24px; }
  .step { display: flex; gap: 6px; padding: 8px 0; border-bottom: 1px solid #182430; align-items: baseline; }
  .step .idx { color: #6e7681; width: 34px; flex-shrink: 0; }
  .step .txt { flex: 1; }
  .step .meta { color: #8b949e; font-size: 0.85em; }
  #current { position: sticky; top: 57px; align-self: start; padding: 16px 24px; border-left: 1px solid #22303c; height: calc(100vh - 57px); overflow-y: auto; }
  #current img { max-width: 100%; border-radius: 8px; border: 1px solid #22303c; }
  #current .reasoning { background: #10151b; padding: 10px; border-radius: 6px; margin-top: 10px; font-size: 0.9em; white-space: pre-wrap; }
  .confidence { font-variant-numeric: tabular-nums; }
  .muted { color: #6e7681; }
</style>
</head>
<body>
<header>
  <h2 id="title">aiqa live</h2>
  <span id="statusPill" class="pill running">running</span>
  <span id="progress" class="muted"></span>
</header>
<main>
  <div id="steps"></div>
  <div id="current"><p class="muted">Waiting for first action...</p></div>
</main>
<script>
async function poll() {
  try {
    const res = await fetch("status.json", { cache: "no-store" });
    if (res.ok) render(await res.json());
  } catch {}
  setTimeout(poll, 1200);
}

function render(s) {
  document.getElementById("title").textContent = \`\${s.scenario} — \${s.environment}/\${s.site}\`;
  const pill = document.getElementById("statusPill");
  pill.textContent = s.status;
  pill.className = "pill " + s.status;
  document.getElementById("progress").textContent =
    \`planner: \${s.plannerModel} | vision: \${s.visionModel} | step \${s.steps.length ? s.steps[s.steps.length-1].index : 0}/\${s.steps.length ? s.steps[s.steps.length-1].total : "?"}\`;

  const stepsEl = document.getElementById("steps");
  stepsEl.innerHTML = s.steps.map(st => \`
    <div class="step">
      <div class="idx">\${st.index}/\${st.total}</div>
      <div class="txt">\${st.step}</div>
      <div class="meta \${st.status}">\${st.status}</div>
    </div>\`).join("");

  const last = s.steps[s.steps.length - 1];
  if (last) {
    document.getElementById("current").innerHTML = \`
      \${last.screenshot ? \`<img src="screenshots/\${last.screenshot}" />\` : ""}
      <div><strong>\${last.intent}</strong> — \${st_target(last)}</div>
      <div class="muted">expected: \${last.expected ?? "-"}</div>
      <div class="confidence">confidence: \${last.confidence ?? "-"} | \${last.durationMs ? last.durationMs + "ms" : ""}</div>
      <div class="reasoning">\${last.reasoning ?? ""}</div>\`;
  }
}
function st_target(st) { return st.target ? st.target : ""; }
poll();
</script>
</body>
</html>`;

export function startLiveServer(paths: RunPaths, port: number): { url: string; close: () => void } {
  const app = express();
  app.get("/", (_req, res) => res.type("html").send(LIVE_HTML));
  app.use("/screenshots", express.static(paths.screenshotsDir));
  app.get("/status.json", (_req, res) => res.sendFile(`${paths.runDir}/status.json`));

  let server: Server;
  try {
    server = app.listen(port);
  } catch {
    server = app.listen(0);
  }
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return { url: `http://localhost:${actualPort}`, close: () => server.close() };
}
