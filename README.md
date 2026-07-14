# qaivision

An AI-native testing platform for SAP Commerce Cloud multisite storefronts.

There are no static Playwright test files. **Natural-language `.nlp` files are the
only test definition.** On every run, the platform reads the `.nlp` scenario, asks a
local LLM (the **Planner Agent**) to turn it into a JSON execution plan, then walks
that plan step by step — a local vision-language model (the **Vision Agent**) looks
at a live screenshot to find each element and validate results, and Playwright only
ever performs mechanical actions (click/type/scroll/select/navigate/upload). The plan
is cached per `.nlp` file (see **Plan caching** below), keyed to its content — edit
the file and the very next run regenerates and behaves differently automatically,
with no code changes.

```
NLP Scenario → Planner Agent → Execution Plan → Vision Agent → Playwright Executor
                                                                        ↓
                                          Reporter ← Validation Agent ← Browser
```

## Quick start (new machine)

Prerequisites: [Node.js 20+](https://nodejs.org), [Ollama](https://ollama.com/download).

```bash
./setup.sh
```

This installs npm dependencies, installs Playwright's Chromium browser, starts
`ollama serve` if it isn't already running, and pulls the two models referenced in
`config/models.yaml`.

Then configure a real site (see **Configuration** below) and run a scenario:

```bash
npm run run -- --env dev --site <site> --scenario <scenario>
```

The command prints a **live viewer URL** (default `http://localhost:4180`) — open it
in a browser to watch the run: current step, live screenshot, the vision model's
reasoning, and its confidence score, updating as each action executes.

## Writing test cases

Test cases are plain text `.nlp` files under `tests/{env}/{site}/{scenario}.nlp`:

```
tests/
    dev/
        <site>/
            complete-e2e.nlp
            smoke.nlp
    stg/...
    prd/...
```

A file starts with three required front-matter lines, then one instruction per line
in plain business language, plus optional `Verify:` blocks:

```
environment: dev
site: <site>
scenario: smoke

Search for the configured product.

Open the first purchasable product.

Verify:
- product name exists
- product code exists
```

Nothing here is Playwright syntax — the Planner Agent decomposes each line into
concrete actions at runtime. To add a new test, just add a new `.nlp` file; to
change what an existing test does, edit its text. No code changes, no rebuild.

Any instruction containing "login"/"log in" is handled deterministically instead
of going through the LLM: it always navigates straight to `{baseUrl}/login`, then
types `{{username}}`/`{{password}}` and clicks the login button. This is faster
and more reliable than asking the model to find a login link to click, since the
URL convention is already known.

## Configuration

| File | Purpose |
|---|---|
| `config/models.yaml` | Which Ollama models the Planner and Vision agents use. |
| `config/sites.yaml` | Base storefront URL per `env`/`site`. |
| `config/products.yaml` | The product under test per `env`/`site` (`{{product}}` in plans). |
| `config/credentials.yaml` | Login credentials per `env`/`site` (`{{username}}`/`{{password}}`). Gitignored — copy from `config/credentials.example.yaml`. |

Before running against a site, fill in its real `baseUrl` in `sites.yaml`, its
product under test in `products.yaml`, and real credentials in `credentials.yaml`
(copy `config/credentials.example.yaml` if you haven't already — `setup.sh` does
this for you). To add another site, add matching entries to all three files plus a
`tests/{env}/{site}/` directory with its `.nlp` scenarios.

### Switching models at any time

Model selection is re-read on every run — no code change or rebuild needed:

```bash
# edit config/models.yaml, or override per-run:
npm run run -- --env dev --site <site> --scenario smoke --vision-model qwen3-vl:32b
AIQA_VISION_MODEL=qwen3-vl:32b npm run run -- --env dev --site <site> --scenario smoke
```

The spec's recommended models are `qwen3-coder:32b` (planner) and `qwen3-vl:32b`
(vision). `config/models.yaml` currently defaults to smaller local models
(`qwen2.5-coder:3b` / `qwen3-vl:8b`) to fit modest disk/VRAM — point it at the 32b
models on a machine with enough headroom and everything else is unchanged.

### Plan caching

Planning (one LLM call per `.nlp` instruction line) is the slowest part of a run
with larger local models, so the generated plan is cached at
`.aiqa-cache/plans/{env}-{site}-{scenario}.json`, keyed to a hash of the `.nlp`
file's raw text + resolved `baseUrl` + planner model name + the planner's internal
logic version (so a qaivision code update always invalidates old cache entries
too, never just an unnoticed stale replay). If none of those changed since the
plan was last generated, the cached plan is reused instantly and no LLM calls
happen during planning at all. Edit the `.nlp` file (or change the site's
`baseUrl`, or switch planner models) and the hash no longer matches, so the next
run regenerates automatically — there's no way for a stale plan to silently run.

Controlled by `--mode`:
- `execute` (default) — reuse the cached plan if it's still valid, else generate and cache it.
- `plan-and-execute` — delete any cached plan for this env/site/scenario and regenerate fresh before running.

## Running

```bash
npm run run -- --env dev --site <site> --scenario smoke
npm run run -- --env stg --site <site> --scenario smoke
npm run run -- --env prd --site all --scenario complete-e2e   # every site under tests/prd/
npm run run -- --env dev --site <site> --scenario smoke --mode plan-and-execute   # force a fresh plan
```

Flags: `--headed` (show the browser), `--live-port <port>`, `--no-live` (skip the
live viewer server), `--verbose` (print every Ollama request/response live),
`--mode execute|plan-and-execute` (plan caching, see above), `--planner-model` /
`--vision-model` (override for one run).

## Run artifacts / replay

Every run writes to `runs/run-{date}-{seq}-{site}-{scenario}/`:

```
plan.json        the Planner Agent's generated execution plan, written before execution starts
screenshots/     one PNG per action
html/index.html  step-by-step replay (screenshot + reasoning per step)
report.json      machine-readable summary + per-step attempts
reasoning.log     newline-delimited JSON of every AI decision made during the run
status.json      live status consumed by the live viewer while the run is active
```

## Recovery strategy

If the Vision Agent can't confidently act on a step, the executor walks a ladder
before failing the step: fresh screenshot → DOM accessibility scan → heuristic DOM
locators → vision-estimated coordinates → alternate workflow (e.g. Tab+type,
Enter-to-submit). Each attempt is logged with its reasoning and confidence in
`reasoning.log` / `report.json`.

## Project layout

```
config/                 models / sites / products / credentials
tests/{env}/{site}/     .nlp scenarios — the only test definitions
src/agents/             NLP parser, Planner Agent, Vision Agent, Ollama client
src/executor/           Playwright action executor + recovery ladder
src/reporter/           report.json / replay HTML / live viewer server
src/cli/run.ts          `aiqa run --env --site --scenario`
runs/                   per-run artifacts (gitignored except .gitkeep)
```

## Known limitations

- Default models are small (3B/8B) to fit modest disk/VRAM; expect materially
  better accuracy from `qwen3-coder:32b` / `qwen3-vl:32b` on adequate hardware.
- Vision calls are the slowest part of each run — a GPU with enough free VRAM to
  fully offload the vision model will be significantly faster than a partial
  CPU/GPU split.
- `config/sites.yaml` / `products.yaml` / `credentials.yaml` ship with placeholder
  values — fill in real ones before testing against a live site.
