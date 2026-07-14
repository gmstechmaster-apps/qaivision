# qaivision — Handover

Status as of commit `383c672` on `main`. Repo: `git@github.com:gmstechmaster-apps/qaivision.git`.

This document exists to hand the project off with full context — what it is, how it
works, what's been fixed, what's still open, and where to look first when something
breaks. It is not meant to replace `README.md` (user-facing setup/usage docs) — read
that first for how to run the thing. This is the "why does it work this way, and
what's unfinished" doc.

## 1. What this is

An AI-native testing platform for SAP Commerce Cloud multisite storefronts, built to
a spec whose core constraint is: **no static Playwright test files, ever.** Tests are
plain-English `.nlp` files. On every run:

```
NLP Scenario → Planner Agent (local LLM) → Execution Plan (JSON)
                                                    ↓
Reporter ← Validation Agent ← Browser ← Vision Agent (local VLM) ← Playwright Executor
```

- **Planner Agent** (`src/agents/planner.ts`): turns each line of a `.nlp` scenario
  into a small JSON array of atomic actions (`navigate`/`click`/`type`/`select`/
  `scroll`/`upload`/`verify`/`wait`). One LLM call per instruction line, run through
  `config/models.yaml`'s `planner.model` via Ollama.
- **Vision Agent** (`src/agents/vision.ts`): given a live screenshot + a target
  description, either locates an element (role/label/confidence) or validates an
  expected result and extracts business data (price, order number, etc). Uses
  `vision.model`.
- **Playwright Executor** (`src/executor/action-executor.ts`): performs only
  mechanical actions. No business logic here — everything about *what* to do lives
  in the plan; everything about *where on screen* lives in the Vision Agent's
  real-time judgment.
- **Reporter** (`src/reporter/reporter.ts`, `src/reporter/live-server.ts`): writes
  per-run artifacts and serves a live web viewer during execution.

The full original spec (business requirements this was built against) is preserved
verbatim at the top of `claude.txt` in the parent directory of this repo, if it's
still present in your environment — worth reading once if you're unfamiliar with the
intent.

## 2. Repo layout

```
config/
  models.yaml               Planner/Vision model selection + Ollama host/timeout
  sites.yaml                baseUrl (+ optional loginPath) per env/site
  products.yaml             product-under-test per env/site
  credentials.yaml          username/password per env/site — GITIGNORED, never commit
  credentials.example.yaml  template — copy to credentials.yaml
tests/{env}/{site}/*.nlp    the only test definitions (env: dev|stg|prd)
src/
  agents/
    nlp-parser.ts           .nlp file → structured NlpScenario (front-matter + steps + Verify blocks)
    planner.ts               NLP steps → ExecutionPlan (see §4 for the deterministic special-cases)
    plan-cache.ts             hash-based cache for generated plans (see §5)
    vision.ts                 locateElement / validateExpectation via Ollama
    ollama-client.ts          thin fetch wrapper around /api/generate, + --verbose logging
    types.ts                  shared types (PlannedAction, ExecutionPlan, StepResult, ...)
  executor/
    action-executor.ts        executes one PlannedAction; 5-strategy recovery ladder (see §6)
  config/
    loader.ts                 reads config/*.yaml, resolves per env/site, CLI/env overrides
  reporter/
    reporter.ts                runs/{run-id}/ artifacts: plan.json, report.json, reasoning.log, html/
    live-server.ts             serves the live viewer (localhost:4180 by default) during a run
  cli/
    run.ts                     entry point — `npm run run -- --env --site --scenario [flags]`
runs/                       per-run artifacts, gitignored except .gitkeep
.aiqa-cache/plans/          plan cache, gitignored entirely (see §5)
setup.sh                    one-shot new-machine setup (npm install, playwright browsers, ollama pulls)
```

## 3. Setup / running (quick reference — see README.md for full detail)

```bash
./setup.sh    # installs deps, playwright chromium, pulls models from config/models.yaml
```

Then fill in `config/sites.yaml` (baseUrl, optionally loginPath), `config/products.yaml`,
and `config/credentials.yaml` (copy from `.example.yaml`) for your real site, and:

```bash
npm run run -- --env dev --site <site> --scenario <scenario>
```

Useful flags: `--headed`, `--verbose` (logs every Ollama request/response live),
`--mode execute|plan-and-execute` (plan caching, see §5), `--planner-model`/
`--vision-model` (override for one run), `--no-live`.

## 4. The planner's deterministic special-cases — important gotcha history

The planner does **not** call the LLM for every instruction. Two categories are
handled in code instead, because letting a small local model guess them turned out
to be actively harmful (it would sometimes hallucinate a plausible-looking but wrong
absolute URL — this happened for real during development, see commit history around
`757e9ec`/`1b8353c`/`a840596`):

- **Login** (`/\blog[\s-]?in\b/i` match on the instruction text): if
  `config/sites.yaml`'s `loginPath` is set for the site, navigates straight to
  `{baseUrl}{loginPath}`. **If `loginPath` is unset (no default — this was a real
  bug, fixed in `1b8353c`), it instead clicks a "Login" link/button** and lets the
  recovery ladder find it, because not every storefront has a dedicated login page —
  some open login as a modal/flyout, and navigating to a guessed URL for those is
  wrong (blank/404 page). **This is probably the single most likely thing to bite the
  next person integrating a new real site** — if login isn't working, check first
  whether `loginPath` is set correctly (or intentionally left unset) for that site.
- **Home page** (`/\bhome\s?page\b|\bstorefront\s+home\b/i` match): always navigates
  straight to `baseUrl`.

**General safety net** (`enforceOnSiteNavigation` in `planner.ts`): for every other
instruction, the LLM is never told what `baseUrl` is — it only ever sees the
instruction text in isolation. So any `navigate` action it proposes is, by
construction, either missing a value or an invented one; it can never be a
legitimately known on-site URL. Any `navigate` whose value isn't verifiably
same-origin as `baseUrl` is automatically downgraded to a `click` against the
current live page instead. **This closes off the whole hallucinated-URL failure
class, not just login/home** — if you're debugging something similar for a new
instruction pattern, this is already handled; look elsewhere first.

`PLANNER_LOGIC_VERSION` (top of `planner.ts`, currently `4`) is folded into the plan
cache's hash key. **Bump it any time you change what actions `planStep` produces for
the same input** — otherwise a code fix can be silently masked by a stale cached
plan generated under the old (buggy) logic. This bit us once already (see §5).

## 5. Plan caching

Planning is the slowest part of a run with larger local models (one LLM call per
`.nlp` line). `.aiqa-cache/plans/{env}-{site}-{scenario}.json` caches the generated
plan, keyed to a SHA-256 hash of: raw `.nlp` text + `baseUrl` + `loginPath` +
planner model name + `PLANNER_LOGIC_VERSION`. Any of those changing invalidates the
hash and forces regeneration — **including a qaivision code update**, which is why
`PLANNER_LOGIC_VERSION` exists and must be bumped (see §4).

`--mode execute` (default): reuse the cached plan if valid, else generate + cache.
`--mode plan-and-execute`: delete the cache for that env/site/scenario and
regenerate fresh regardless.

The cache directory is entirely gitignored — it's a local speed optimization, not
part of the source of truth (the `.nlp` files are).

## 6. Executor recovery ladder

For `click`/`type`/`select`/`scroll`/`upload` actions, `action-executor.ts` tries, in
order, until one succeeds:

1. **Fresh screenshot** → Vision Agent locates the element (role + accessible label) → Playwright `getByRole`.
2. **DOM accessibility scan** — walks interactive elements in the live DOM, scores
   accessible name against the target description, tags the best match with a temp
   `data-aiqa-recovery` attribute (works around `page.accessibility` being removed in
   the installed Playwright version — see comment in the code).
3. **Heuristic DOM locators** — `getByPlaceholder`/`getByLabel`/`getByText` guesses.
4. **Vision-estimated coordinates** — asks the Vision Agent for normalized (0-1)
   click coordinates as a last resort before giving up on semantic locators.
5. **Alternate workflow** — blind `Tab`+type or `Enter`-to-submit. This is a real
   fallback of last resort; it "succeeds" (doesn't throw) even when it's not
   meaningful, which produced some confusing-looking but *technically correct*
   PASS results during a real end-to-end test run when the plan had over-decomposed
   a simple form into more fields than existed (see §8, "over-decomposition").

Every attempt (strategy, reasoning, confidence, success/error) is recorded per step
in `attempts` — visible in `report.json` and `reasoning.log`.

`navigate` and `verify` intents don't use this ladder — `navigate` either goes
straight through (same-origin URL) or gets downgraded to `click` before execution
even starts (§4); `verify` always goes straight to the Vision Agent against the
current screenshot.

## 7. Known issues / things I'd look at next

- **Blank screenshots on JS-heavy real sites (just fixed, unverified on a real
  site)**: `page.goto` only waits for `domcontentloaded`, which fires before a
  React/Angular-style SPA storefront has actually painted content. A screenshot
  taken immediately after (whether post-navigation or post-click, e.g. an SPA route
  change) could be genuinely blank — this was reported directly ("the empty image is
  sent to the qwen it seems") and matches an earlier "white page in the live viewer"
  report too. Fixed in `383c672` by adding a best-effort `waitForLoadState
  ("networkidle", { timeout: 5000 })` inside `screenshotBase64()`, centralized so
  every screenshot call site benefits. **This was fixed shortly before handover and
  has not yet been confirmed against a real production storefront** — if screenshots
  are still blank after pulling this, the 5s timeout may not be enough for a
  particularly slow site, or the site may have genuinely persistent network activity
  (polling/websockets) that never reaches "networkidle" at all, in which case a
  different readiness signal (e.g. waiting for a specific selector, or a fixed
  settle delay) would be needed instead.
- **Over-decomposition on simple forms**: with a small/local planner model, a
  single NLP instruction like "Proceed through checkout." can get decomposed into
  more granular field-by-field actions than a given checkout form actually has
  (e.g. assuming separate shipping first-name/last-name fields on a form that just
  has one "Shipping Address" field). Each nonexistent field then walks the full
  recovery ladder before falling back to the blind "alternate workflow" strategy,
  which is slow (many wasted LLM calls) and produces misleadingly generic PASS
  results. Not fixed — mitigations would be either a stronger/larger planner model
  (this got noticeably better reasoning from `qwen3-coder:30b` vs `qwen2.5-coder:3b`
  in testing) or tightening the few-shot examples in `planner.ts` further.
  Worth testing whether the vision-model-driven screenshot fix in this same session
  also happens to reduce over-decomposition (it wouldn't directly, but a plan
  generated against better screenshots later in a scenario might behave better —
  untested speculation, not confirmed).
- **Login click-fallback is unverified against a real modal-based login.** The logic
  is sound and unit-tested (see `git log` around `1b8353c` for the sanity check
  approach used), but no real site with a modal login flow has been run against it
  yet — only the deterministic navigate-based path and the synthetic mock storefront
  (since removed, see §9) have been exercised end-to-end.
- **`--verbose` output is unbounded** — it prints the full system prompt + prompt +
  raw response for every single Ollama call, live, with no truncation. Fine for
  debugging, would be noisy/unusable left on for a long scenario. No flag exists to
  cap output length; consider adding one if this becomes a regular debugging tool
  rather than an occasional one.
- **No automated test suite.** Everything in this project has been verified by
  actually running it (real end-to-end runs, targeted sanity scripts written and
  discarded during development — see git history commit messages for what was
  checked and how). There is no `npm test` beyond re-running the CLI itself. If this
  project grows, adding real unit tests around `planner.ts`'s special-cases and
  `plan-cache.ts`'s hash invalidation (both have clear, narrow, high-value test
  surfaces) would pay off — the sanity-check patterns used ad hoc during development
  are a reasonable starting point.

## 8. Notable design decisions worth knowing before changing things

- **`config/models.yaml`'s `ollama.host` defaults to `http://127.0.0.1:11434`, not
  `localhost`** — this was a real, reported failure: on at least one Mac setup,
  `localhost` resolved to IPv6 (`::1`) while Ollama only listened on IPv4, so
  requests never reached the server at all. This looked exactly like Ollama
  "staying idle" in Activity Monitor while qaivision hung with no error — very
  confusing to debug from the symptom alone. `restart-ollama.sh` kills any running
  Ollama process and restarts it explicitly bound to the same `127.0.0.1` address,
  so client and server are guaranteed to agree. If a future environment needs a
  non-default host (remote Ollama, Docker, etc.), use `AIQA_OLLAMA_HOST` or edit
  `models.yaml` directly rather than relying on `localhost` resolution.
- **Ollama's `format:"json"` is deliberately NOT used** (`ollama-client.ts`). It
  measurably breaks structured output for the smaller local models tested here —
  collapses array output to a single object, or returns an empty string entirely for
  the vision model. Plain generation + a bracket-matching JSON salvager
  (`extractJson`) was measurably more reliable. If you're tempted to re-enable strict
  JSON mode (e.g. because a newer/larger model handles it fine), verify carefully
  against whatever model you're actually using — this isn't a universal Ollama
  limitation, it was model-specific behavior observed directly.
- **The MoE vs. dense model distinction matters for planner model choice.**
  `qwen3-coder:30b` is a Mixture-of-Experts model (~3B active params per token
  despite ~30B total), so it's dramatically cheaper to run than a dense model of
  similar total size (e.g. `qwen3:32b`). Recommended over a general dense 32B model
  both for output-schema discipline (coder-tuned models are more reliable at
  sticking to a strict JSON schema) and raw speed.
- **`page.accessibility` doesn't exist in the installed Playwright version** (it was
  removed upstream). The "accessibility_tree" recovery strategy is actually a manual
  DOM scan (`tryAccessibilityTree` in `action-executor.ts`) that approximates the
  same idea by walking interactive elements and scoring accessible names — not a
  real accessibility tree API call. Don't be misled by the strategy's name if you're
  debugging it.
- **Credentials are never sent to the LLM or logged.** The planner emits
  `{{username}}`/`{{password}}` tokens, resolved only at execution time
  (`resolveValue` in `action-executor.ts`), and `redact()` scrubs both the raw
  values and the username token out of anything that reaches `reasoning.log` or
  console output. If you add a new secret-bearing field, follow this same pattern —
  token in the plan, resolve + redact at the executor boundary.

## 9. Things that were built and then deliberately removed

Early in development, a self-contained mock Express storefront
(`src/mock-storefront/`) and a `demo-store` test site were built to prove the
pipeline end-to-end without needing real site credentials. **These were explicitly
requested to be removed** once real site work started (the user considered them
scaffolding, not part of the product) — see commit `2f86d88`. If you're looking for
a way to test changes without hitting a real site, that capability doesn't exist
anymore by design; the closest equivalent now is the sanity-check pattern used
throughout later development (small standalone `.mts` scripts under the repo root,
run via `npx tsx`, then deleted — see git history for many examples of the exact
pattern used to verify each fix in isolation before committing).

## 10. Git / deployment state

- Remote: `git@github.com:gmstechmaster-apps/qaivision.git` (SSH auth already
  configured in this environment via `~/.ssh/config`'s `id_ed25519_studygarden` key
  — HTTPS push failed here with no stored credentials, SSH worked immediately).
- Branch: `main`, tracking `origin/main`, no divergence as of this document.
- Every change in this project's history so far has been pushed immediately after
  commit — there is no unpushed local work as of `383c672`.
- No CI/CD configured. No branch protection. No PR review process has been used —
  all commits are direct to `main`.
