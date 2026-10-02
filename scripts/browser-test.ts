#!/usr/bin/env node
/**
 * Browser test. Serves a local page and drives the real headless Chromium
 * through BrowserSession: open, read, type, click, screenshot.
 *
 * Skipped automatically when the Playwright browser is not installed.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { BrowserSession } from "../internal/browser/session.ts";
import { specsFor } from "../internal/agent/tools.ts";

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ""): void {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

const PAGE = `<!DOCTYPE html><html><head><title>Agent Test Page</title></head>
<body><main>
  <h1>Hello from the sandbox</h1>
  <p id="greeting">unwritten</p>
  <input id="name" type="text" />
  <button id="go" onclick="document.getElementById('greeting').textContent =
    'Hello, ' + (document.getElementById('name').value || 'nobody')">Go</button>
</main></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
const port = 8123;
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

const shotDir = mkdtempSync(join(tmpdir(), "fw-browser-"));
const session = new BrowserSession({
  screenshotDir: shotDir,
  maxOutput: 2000,
  navTimeoutMs: 15_000,
});

console.log("\n1. tool spec is opt-in");
check("browser hidden by default", !specsFor(false).some((t) => t.name === "browser"));
check("browser present when enabled", specsFor(true).some((t) => t.name === "browser"));

console.log("\n2. navigate");
const opened = await session.act("open", { url: `http://127.0.0.1:${port}/` });
check("open succeeds", opened.ok, opened.output.split("\n")[0]);
check("title read back", opened.output.includes("Agent Test Page"));
check("screenshot written", Boolean(opened.screenshot) && existsSync(opened.screenshot!));

console.log("\n3. read page text");
const read = await session.act("read", {});
check("read succeeds", read.ok);
check("heading extracted", read.output.includes("Hello from the sandbox"), "innerText path");

console.log("\n4. reject a non-http url");
const bad = await session.act("open", { url: "file:///etc/passwd" });
check("file:// rejected", !bad.ok && bad.output.includes("http://"), bad.output.slice(0, 60));

console.log("\n5. type and click");
const typed = await session.act("type", { selector: "#name", text: "operator" });
check("type succeeds", typed.ok, typed.output.slice(0, 60));
const clicked = await session.act("click", { selector: "#go" });
check("click succeeds", clicked.ok, clicked.output.split("\n")[0]);
const afterClick = await session.act("read", {});
check(
  "page reflects interaction",
  afterClick.output.includes("Hello, operator"),
  afterClick.output.includes("Hello, operator") ? "greeting updated" : "greeting stale",
);

console.log("\n6. unknown action is reported, not thrown");
const bogus = await session.act("teleport", {});
check("unknown action rejected", !bogus.ok && bogus.output.includes("unknown browser action"));

console.log("\n7. screenshot files");
await session.act("screenshot", {});
const shots = readdirSync(shotDir).filter((f) => f.endsWith(".png"));
check("multiple screenshots on disk", shots.length >= 3, `${shots.length} files`);

console.log("\n8. recovery after a dead page");
// Regression: a crashed browser used to leave the session permanently broken,
// and every later action failed with "Target page, context or browser closed".
const dead = new BrowserSession({
  screenshotDir: shotDir,
  maxOutput: 2000,
  navTimeoutMs: 15_000,
});
await dead.act("open", { url: `http://127.0.0.1:${port}/` });
check("session started", dead.started);
await dead.shutdown();
check("session stopped after shutdown", !dead.started);
const revived = await dead.act("open", { url: `http://127.0.0.1:${port}/` });
check("relaunches after shutdown", revived.ok, revived.output.split("\n")[0]);
await dead.shutdown();

console.log("\n9. captureQuietly is safe when nothing is running");
const idle = new BrowserSession({
  screenshotDir: shotDir,
  maxOutput: 500,
  navTimeoutMs: 5000,
});
const nothing = await idle.captureQuietly();
check("capture without a browser returns undefined", nothing === undefined);
await idle.shutdown();

console.log("\n10. close and shutdown");
const closed = await session.act("close", {});
check("close succeeds", closed.ok);
check("session reports stopped", !session.started);
await session.shutdown();

await new Promise<void>((resolve) => server.close(() => resolve()));
rmSync(shotDir, { recursive: true, force: true });

console.log(`\n${failures.length ? "FAILED" : "PASSED"}: ${failures.length} failure(s)`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);