# Free Will Day

An autonomous agent runs for 24 hours with no instructions, in a sandbox, fully
observed. TypeScript drives the agent, Go supervises the run.

## Layout

```
cmd/agent/          agent entrypoint (TS)
cmd/supervisor/     supervisor entrypoint (Go)
internal/config/    shared paths, limits, and model credentials
internal/llm/       model client: anthropic + openai wire formats
internal/logger/    actions.jsonl writer (TS)
internal/agent/     loop and tools
internal/database/  action log reader (Go)
internal/watchdog/  stop conditions and pathology detection (Go)
internal/auth/      dashboard auth (Go)
internal/dashboard/ http server and view model (Go)
internal/supervisor/ reserved
web/templates/      dashboard.html
workspace/          the agent's free area
memory/             journal.md, goals.md, state.json
logs/               actions.jsonl, screenshots/
deploy/             systemd units and run script
scripts/            fake model, smoke test
```

TypeScript and Go cannot share a package directory, so `internal/` is split by
domain and the language is implied by the files in each folder.

## Requirements

Node 22.6+ (runs `.ts` directly, no build step) and Go 1.24+. The Go side is
stdlib only. No `npm install` is required for a basic run: the agent uses
`fetch` and `node:` builtins.

## Quick start

```bash
cp .env.example .env      # set MODEL_API_KEY
npm run smoke             # fake model, full loop, assertions, no cost
npm run test:browser      # drives real headless Chromium, needs playwright
```

`npm run smoke` runs 24 assertions in eight phases: a fake model drives the
agent loop, the supervisor is built and started, then the log, journal,
workspace output, dashboard auth, dashboard rendering, the STOP endpoint, and a
clean halt on the STOP file are all checked. Phase 8 additionally drives the
real browser through the loop and confirms screenshots reach the dashboard.

`npm run test:browser` exercises the browser tool directly against a local page:
navigate, read, type, click, relaunch after a dead page, and screenshot capture.

Neither test needs an API key, network access, or any cost.

## Running for real

```bash
go build -o bin/supervisor ./cmd/supervisor
node cmd/agent/main.ts &
./bin/supervisor &
ssh -N -L 8080:127.0.0.1:8080 you@vps
```

Dashboard at `http://127.0.0.1:8080`. Set `DASHBOARD_USER` and
`DASHBOARD_PASSWORD` and the browser will prompt for them.

`deploy/run.sh` does the same in one step; `deploy/*.service` are the systemd
equivalents.

## Model endpoints

`MODEL_BASE_URL` is required and any Anthropic- or OpenAI-shaped endpoint works:
hosted APIs, OpenRouter, vLLM, LiteLLM, or a local gateway. `MODEL_STYLE` picks
the wire format only, not the vendor.

When the endpoint sits behind a credential proxy, set `MODEL_BASIC_USER` and
`MODEL_BASIC_PASS`. The client then sends `Authorization: Basic` instead of
`x-api-key`, which covers gateways that gate access with a username and password
rather than a key.

Cost is computed from the `usage` field the provider returns, not from string
length. Adjust `PRICE_INPUT_PER_M` and `PRICE_OUTPUT_PER_M` to your model.

## Tools available to the agent

`shell`, `read_file`, `write_file`, `list_dir`, `write_journal`. Paths resolve
against the workspace or memory root and are rejected if they escape. Shell
commands get a scrubbed environment: `HOME` points at the workspace, so
`~/.ssh` and friends do not exist.

Set `ENABLE_BROWSER=1` to add a sixth tool, `browser`, backed by headless
Chromium via Playwright. It is lazy-loaded, so a run with the browser off needs
no dependency at all.

```
npm install
npx playwright install --with-deps chromium
```

Actions: `open` (needs `url`, must be http or https), `read` (visible text),
`click` and `type` and `press` (need `selector`), `back`, `screenshot`,
`close`. Every interactive action saves a PNG to `logs/screenshots/`, and
`SCREENSHOT_EVERY_MINUTES` (default 5) captures on a timer regardless of what
the model is doing. A dead page is detected and relaunched rather than left
broken, which matters over a 24 hour run.

Browser tests are skipped automatically when the Playwright browser is not
installed, so the smoke test still passes on a machine without it.

## Stop conditions

Three, checked independently by both processes:

1. `STOP` file exists — the dashboard button writes it, or `touch STOP` over SSH
2. Spend reaches `MAX_BUDGET_USD`
3. `RUN_DURATION` elapsed

The agent checks before every iteration; the supervisor checks every 20 seconds
and writes the STOP file itself, so a halt still happens if the agent stops
checking. Model output that asks for credentials or for the sandbox to be
disabled halts the run rather than being obeyed.

## Reading the log later

`actions.jsonl` is append-only, one JSON object per line. The supervisor only
ever reads it. Analysis for phase 6 works off that file plus a diff of
`workspace/`, not off the journal, since the journal is written by the agent
under observation.