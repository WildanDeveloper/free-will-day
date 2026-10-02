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
npm run test              # all three suites
npm run test:unit         # compaction and loop detection, no model needed
npm run test:browser      # real headless Chromium
npm run smoke             # full integration, 36 assertions
```

`npm run smoke` runs ten phases: the agent loop against a fake model, the
supervisor and dashboard with auth, the STOP endpoint and a clean halt, real
compaction and stuck-loop detection inside the loop, alert webhook delivery,
then the browser tool and screenshots end to end.

`npm run test:unit` covers compaction and loop detection as pure logic, including
the failure paths: a model that errors, an empty summary, repeated calls with
different inputs, and interleaved actions.

`npm run test:browser` drives Chromium against a local page: navigate, read,
type, click, relaunch after a dead page, screenshot capture.

No suite needs an API key, network access, or any cost.

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

## Context management

The agent keeps no conversation history. Each iteration rebuilds a fresh prompt
from durable state: `goals.md`, the journal tail, and a bounded window of recent
actions.

Every `SUMMARIZE_EVERY` actions the window is compacted for real: the model is
asked to write a hand-off note to itself, that note goes into `journal.md` under
an `auto summary` heading, and the window is dropped. This is what preserves
intent over 24 hours. Silently truncating history instead is how an agent
forgets its own goal by hour six, and `SUMMARIZE_EVERY=6` in the test suite is
what catches that regression.

## Stuck-loop detection

If the same tool is called with byte-identical input `LOOP_DETECTION_THRESHOLD`
times in a row, the next prompt gets a nudge naming the repeated tool and
offering three ways out, one of which is writing down the blocker. Detection is
on tool name plus input hash, so the same tool with different arguments is not
flagged, and interleaved distinct actions are not flagged either.

## Alerts

Set `ALERT_WEBHOOK_URL` and the supervisor posts JSON on: a run halting, idle
beyond `IDLE_ALERT_MINUTES`, a spend spike past `COST_ALERT_USD`, and a stuck
loop. One payload shape covers Discord and Telegram, and `ALERT_COOLDOWN`
(default 10m) prevents a flapping condition from flooding the channel. Alerts
are best effort: a failed webhook is logged and never blocks the run.

Without the variable, alerting is off and every call is a no-op.

## Surviving 24 hours

- **Restarts.** The agent systemd unit uses `Restart=always`. `state.json` holds
  an absolute deadline, so a restart continues the same run instead of starting
  a fresh one. `StartLimitBurst=5` within 10 minutes stops a broken
  configuration from spinning forever.
- **Log reads are bounded.** `readRecent` reads only the tail of
  `actions.jsonl`. A full run produces roughly 40MB; reading the whole file each
  iteration would cost about 800GB of IO.
- **Journal rotation.** Past 8MB the journal is trimmed to its newer half, cut at
  an entry boundary. Only the tail is ever loaded into a prompt, so older text
  was dead weight.
- **Process recycling.** `MAX_PROCESS_RUNTIME_MINUTES` exits one process cleanly
  after N minutes so a supervisor can recycle it. 0, the default, leaves a single
  process running the full duration.

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