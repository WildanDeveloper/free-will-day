#!/usr/bin/env node
/**
 * Smoke test. Starts the fake model, runs the agent loop for a few seconds,
 * starts the supervisor, then verifies the log, journal, and dashboard.
 *
 * No API key, no network, no cost. This is the "does it work at all" gate.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const SANDBOX = `${ROOT}.smoke`;
const PORT_AGENT_MODEL = 8099;
const PORT_BROWSER_MODEL = 8097;
const PORT_DASH = 8098;
const PORT_SHOT_DASH = 8096;
const PORT_PAGE = 8123;

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ""): void {
  const mark = condition ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

/** Refuse to run on occupied ports: a stale child would invalidate every assertion. */
async function assertPortFree(port: number): Promise<void> {
  const probe = spawn(
    "node",
    ["-e", `fetch("http://127.0.0.1:${port}/").then(()=>process.exit(1)).catch(()=>process.exit(0))`],
  );
  const busy = await new Promise<boolean>((resolve) => {
    probe.on("close", (code) => resolve(code === 1));
    probe.on("error", () => resolve(false));
  });
  if (busy) {
    console.error(`port ${port} is already in use; stop the stale process first`);
    process.exit(2);
  }
}

const children: ChildProcess[] = [];

function cleanup(): void {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

function run(cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  children.push(child);
  return child;
}

rmSync(SANDBOX, { recursive: true, force: true });
for (const dir of ["workspace", "memory", "logs", "logs/screenshots"]) {
  spawn("mkdir", ["-p", `${SANDBOX}/${dir}`]);
}
await sleep(150);

console.log("\n0. ports");
await assertPortFree(PORT_AGENT_MODEL);
await assertPortFree(PORT_BROWSER_MODEL);
await assertPortFree(PORT_DASH);
await assertPortFree(PORT_SHOT_DASH);
await assertPortFree(PORT_PAGE);

console.log("\n1. fake model");
const fake = run("node", ["scripts/fake-model.ts"], {
  FAKE_MODEL_PORT: String(PORT_AGENT_MODEL),
});
await sleep(400);

console.log("\n2. agent loop (8 seconds)");
const agent = run("node", ["cmd/agent/main.ts"], {
  MODEL_BASE_URL: `http://127.0.0.1:${PORT_AGENT_MODEL}`,
  MODEL_API_KEY: "fake-key",
  MODEL_STYLE: "anthropic",
  MODEL_ID: "fake-model",
  MODEL_BASIC_USER: "user",
  MODEL_BASIC_PASS: "pass",
  FAKE_REQUIRE_BASIC: "1",
  WORKSPACE_DIR: `${SANDBOX}/workspace`,
  MEMORY_DIR: `${SANDBOX}/memory`,
  LOGS_DIR: `${SANDBOX}/logs`,
  STOP_FILE: `${SANDBOX}/STOP`,
  STATE_FILE: `${SANDBOX}/memory/state.json`,
  RUN_DURATION: "10m",
  MAX_BUDGET_USD: "100",
  SLEEP_MS: "100",
  SUMMARIZE_EVERY: "5",
  JOURNAL_EVERY_MINUTES: "0",
});
await sleep(8000);
agent.kill("SIGTERM");
await sleep(300);

console.log("\n3. supervisor + dashboard");
// Build once up front so `go run` compile time is not measured against the test.
const binary = `${SANDBOX}/supervisor`;
const build = spawnSync("go", ["build", "-o", binary, "./cmd/supervisor"], {
  cwd: ROOT,
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error("go build failed");
  process.exit(2);
}
const supervisor = run(binary, [], {
  WORKSPACE_DIR: `${SANDBOX}/workspace`,
  MEMORY_DIR: `${SANDBOX}/memory`,
  LOGS_DIR: `${SANDBOX}/logs`,
  STOP_FILE: `${SANDBOX}/STOP`,
  ACTIONS_FILE: `${SANDBOX}/logs/actions.jsonl`,
  JOURNAL_FILE: `${SANDBOX}/memory/journal.md`,
  STATE_FILE: `${SANDBOX}/memory/state.json`,
  TEMPLATE_DIR: `${ROOT}web/templates`,
  SUPERVISOR_ADDR: `127.0.0.1:${PORT_DASH}`,
  MAX_BUDGET_USD: "100",
  DASHBOARD_USER: "admin",
  DASHBOARD_PASSWORD: "hunter2",
});
await sleep(6000);

console.log("\n4. assertions");

const logPath = `${SANDBOX}/logs/actions.jsonl`;
check("actions.jsonl exists", existsSync(logPath));

const raw = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
const lines = raw.split("\n").filter(Boolean);
check("log has records", lines.length > 0, `${lines.length} lines`);

let parsedAll = true;
let actionCount = 0;
let toolCalls = 0;
for (const line of lines) {
  try {
    const rec = JSON.parse(line) as { type: string; tool?: string; costUsd?: number };
    if (rec.type === "action") {
      actionCount += 1;
      if (rec.tool && rec.tool !== "(no tool call)") toolCalls += 1;
    }
  } catch {
    parsedAll = false;
  }
}
check("every line is valid JSON", parsedAll);
check("actions recorded", actionCount > 0, `${actionCount} actions`);
check("tool calls recorded", toolCalls > 0, `${toolCalls} tool calls`);
check("cost accumulated", raw.includes("costUsd"));

check(
  "agent wrote a workspace file",
  existsSync(`${SANDBOX}/workspace/notes/hello.md`),
);
check(
  "journal written",
  existsSync(`${SANDBOX}/memory/journal.md`) &&
    readFileSync(`${SANDBOX}/memory/journal.md`, "utf8").includes("##"),
);
check("state.json written", existsSync(`${SANDBOX}/memory/state.json`));

console.log("\n5. dashboard over HTTP");
const authHeader = `Basic ${Buffer.from("admin:hunter2").toString("base64")}`;

try {
  const unauth = await fetch(`http://127.0.0.1:${PORT_DASH}/`);
  check("unauthenticated request rejected", unauth.status === 401, `status ${unauth.status}`);
} catch (err) {
  check("unauthenticated request rejected", false, (err as Error).message);
}

try {
  const res = await fetch(`http://127.0.0.1:${PORT_DASH}/`, {
    headers: { Authorization: authHeader },
  });
  const html = await res.text();
  check("dashboard responds with auth", res.status === 200);
  check("dashboard renders actions", html.includes("Latest actions"));
  check("dashboard shows spend", html.includes("Spend"));
  check("dashboard shows journal", html.includes("Journal tail"));
  check("dashboard has STOP button", html.includes("/stop"));
} catch (err) {
  check("dashboard responds with auth", false, (err as Error).message);
}

try {
  const res = await fetch(`http://127.0.0.1:${PORT_DASH}/api/summary`, {
    headers: { Authorization: authHeader },
  });
  const summary = (await res.json()) as { totals: { actions: number; costUsd: number } };
  check("summary API works", res.status === 200 && summary.totals.actions > 0,
    `${summary.totals.actions} actions, $${summary.totals.costUsd.toFixed(4)}`);
} catch (err) {
  check("summary API works", false, (err as Error).message);
}

console.log("\n6. STOP button halts the run");
try {
  const res = await fetch(`http://127.0.0.1:${PORT_DASH}/stop`, {
    method: "POST",
    headers: { Authorization: authHeader },
    redirect: "manual",
  });
  check("POST /stop accepted", res.status === 303, `status ${res.status}`);
  check("STOP file created", existsSync(`${SANDBOX}/STOP`));
} catch (err) {
  check("POST /stop accepted", false, (err as Error).message);
}

console.log("\n7. agent halts on STOP file");
const agent2 = run("node", ["cmd/agent/main.ts"], {
  MODEL_BASE_URL: `http://127.0.0.1:${PORT_AGENT_MODEL}`,
  MODEL_API_KEY: "fake-key",
  MODEL_STYLE: "anthropic",
  MODEL_ID: "fake-model",
  WORKSPACE_DIR: `${SANDBOX}/workspace`,
  MEMORY_DIR: `${SANDBOX}/memory`,
  LOGS_DIR: `${SANDBOX}/logs`,
  STOP_FILE: `${SANDBOX}/STOP`,
  STATE_FILE: `${SANDBOX}/memory/state.json`,
  RUN_DURATION: "10m",
  SLEEP_MS: "100",
});
await sleep(2500);
const exitedCleanly = agent2.exitCode === 0 || agent2.exitCode === null;
check("agent exits on STOP without error", exitedCleanly, `exit ${agent2.exitCode}`);
agent2.kill("SIGKILL");

// Phase 8: the browser tool inside the real loop. Needs the Playwright browser,
// so it is skipped rather than failed when that is not installed.
console.log("\n8. browser tool in the loop");
const playwrightInstalled = existsSync(
  join(process.env.HOME ?? "/root", ".cache/ms-playwright"),
);
if (!playwrightInstalled) {
  console.log("  [SKIP] playwright browser not installed (npx playwright install chromium)");
} else {
  const pageServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!DOCTYPE html><html><head><title>Smoke Page</title></head><body><main>` +
        `<h1>Smoke Page</h1><p id="g">unwritten</p>` +
        `<input id="name" /><button id="go" onclick="document.getElementById('g').textContent=` +
        `'Hello, '+(document.getElementById('name').value||'nobody')">Go</button>` +
        `</main></body></html>`,
    );
  });
  await new Promise<void>((r) => pageServer.listen(PORT_PAGE, "127.0.0.1", r));

  // Separate port and a separate log dir: the phase 1 fake model is still
  // running, and its actions.jsonl is already asserted on above.
  const BROWSER_LOGDIR = `${SANDBOX}/logs-browser`;
  spawn("mkdir", ["-p", `${BROWSER_LOGDIR}/screenshots`]);
  await sleep(100);

  const fakeBrowser = run("node", ["scripts/fake-model.ts"], {
    FAKE_MODEL_PORT: String(PORT_BROWSER_MODEL),
    FAKE_BROWSER_SCRIPT: "1",
    FAKE_PAGE_URL: `http://127.0.0.1:${PORT_PAGE}/`,
  });

  // Wait for readiness rather than sleeping a fixed amount: a cold Node start
  // used to lose the race, and the agent's first turn then ran without `open`.
  let modelReady = false;
  for (let attempt = 0; attempt < 40 && !modelReady; attempt += 1) {
    await sleep(250);
    try {
      // GET, not POST: a POST would advance the fake model's script and the
      // agent would miss its first turn.
      const probe = await fetch(`http://127.0.0.1:${PORT_BROWSER_MODEL}/`);
      modelReady = probe.ok;
    } catch {
      // Not listening yet.
    }
  }
  check("browser fake model reachable", modelReady);

  // Same for the page server, so `open` cannot lose the race either.
  let pageReady = false;
  for (let attempt = 0; attempt < 20 && !pageReady; attempt += 1) {
    await sleep(100);
    try {
      const probe = await fetch(`http://127.0.0.1:${PORT_PAGE}/`);
      pageReady = probe.ok;
    } catch {
      // Not listening yet.
    }
  }
  check("test page reachable", pageReady);

  const browserAgent = run("node", ["cmd/agent/main.ts"], {
    MODEL_BASE_URL: `http://127.0.0.1:${PORT_BROWSER_MODEL}`,
    MODEL_API_KEY: "fake-key",
    MODEL_STYLE: "anthropic",
    MODEL_ID: "fake-model",
    WORKSPACE_DIR: `${SANDBOX}/workspace`,
    MEMORY_DIR: `${SANDBOX}/memory`,
    LOGS_DIR: BROWSER_LOGDIR,
    STOP_FILE: `${SANDBOX}/STOP_BROWSER`,
    STATE_FILE: `${SANDBOX}/memory/state-browser.json`,
    RUN_DURATION: "10m",
    SLEEP_MS: "150",
    ENABLE_BROWSER: "1",
  });
  await sleep(9000);
  browserAgent.kill("SIGTERM");
  fakeBrowser.kill("SIGTERM");
  await new Promise<void>((r) => pageServer.close(() => r()));

  const shotsDir = `${BROWSER_LOGDIR}/screenshots`;
  const shots = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => f.endsWith(".png")) : [];
  check("screenshots captured by the loop", shots.length > 0, `${shots.length} png files`);

  const browserLog = existsSync(`${BROWSER_LOGDIR}/actions.jsonl`)
    ? readFileSync(`${BROWSER_LOGDIR}/actions.jsonl`, "utf8")
    : "";
  check("browser tool calls logged", browserLog.includes('"tool":"browser"'));

  if (shots.length > 0) {
    // The supervisor reads screenshots from LOGS_DIR/screenshots, so it needs a
    // supervisor pointed at the browser log dir. The phase 3 one still holds
    // PORT_DASH, so give this one its own port instead of colliding silently.
    const shotSupervisor = run(binary, [], {
      SUPERVISOR_ADDR: `127.0.0.1:${PORT_SHOT_DASH}`,
      WORKSPACE_DIR: `${SANDBOX}/workspace`,
      MEMORY_DIR: `${SANDBOX}/memory`,
      LOGS_DIR: BROWSER_LOGDIR,
      STOP_FILE: `${SANDBOX}/STOP_BROWSER`,
      ACTIONS_FILE: `${BROWSER_LOGDIR}/actions.jsonl`,
      JOURNAL_FILE: `${SANDBOX}/memory/journal.md`,
      STATE_FILE: `${SANDBOX}/memory/state-browser.json`,
      TEMPLATE_DIR: `${ROOT}web/templates`,
      MAX_BUDGET_USD: "100",
      DASHBOARD_USER: "admin",
      DASHBOARD_PASSWORD: "hunter2",
    });
    await sleep(1200);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT_SHOT_DASH}/screenshot`, {
        headers: { Authorization: authHeader },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      check("dashboard serves the screenshot", res.status === 200 && buf.length > 1000,
        `${res.status}, ${buf.length} bytes`);
    } catch (err) {
      check("dashboard serves the screenshot", false, (err as Error).message);
    }
    shotSupervisor.kill("SIGTERM");
    await sleep(300);
  }
}

supervisor.kill("SIGTERM");
fake.kill("SIGTERM");
await sleep(500);

console.log(`\n${failures.length ? "FAILED" : "PASSED"}: ${failures.length} failure(s)`);
for (const f of failures) console.log(`  - ${f}`);
if (!process.env.SMOKE_KEEP) rmSync(SANDBOX, { recursive: true, force: true });
else console.log(`artifacts kept in ${SANDBOX}`);
process.exit(failures.length ? 1 : 0);