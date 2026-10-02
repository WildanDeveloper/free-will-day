#!/usr/bin/env node
/**
 * Soak runner for Phase 4: long unattended runs against a real model.
 *
 * Starts the supervisor and the agent together, samples state on an interval,
 * and writes a report when the run ends. Everything about the run is
 * timestamped and persisted, so a run that outlives this process can still be
 * inspected afterwards.
 *
 * Usage:
 *   node scripts/soak.ts --minutes 120 [--run-id tag] [--resume]
 *
 * It never invents a verdict. The report states what was measured; judging
 * whether the run went well is the operator's call.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MINUTES = Number(arg("minutes", "120"));
const RUN_ID = arg("run-id", new Date().toISOString().replace(/[:.]/g, "-"));
const RESUME = process.argv.includes("--resume");
const SAMPLE_SECONDS = Number(arg("sample", "300"));
const RUN_DIR = join(ROOT, "soak", RUN_ID);

type Sample = {
  at: string;
  actions: number;
  errors: number;
  summaries: number;
  stuckNotices: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  idleMinutes: number;
  journalBytes: number;
  journalEntries: number;
  workspaceFiles: number;
  screenshots: number;
  processAlive: boolean;
  state: Record<string, number>;
};

const children: ChildProcess[] = [];

function shutdown(): void {
  for (const c of children) {
    if (c.exitCode === null && !c.killed) c.kill("SIGTERM");
  }
}
process.on("exit", shutdown);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

function readJsonl(file: string): Record<string, any>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function readState(file: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

/** Count files under a directory, ignoring dotdirs. */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}

function countScreenshots(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".png")).length;
  } catch {
    return 0;
  }
}

function journalEntries(file: string): number {
  try {
    const text = readFileSync(file, "utf8");
    return (text.match(/^## /gm) ?? []).length;
  } catch {
    return 0;
  }
}

function sample(agentAlive: boolean): Sample {
  const records = readJsonl(join(RUN_DIR, "logs", "actions.jsonl"));
  const state = readState(join(RUN_DIR, "memory", "state.json"));

  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let errors = 0;
  let summaries = 0;
  let stuckNotices = 0;
  let actions = 0;
  let lastTs = 0;

  for (const r of records) {
    costUsd += r.costUsd ?? 0;
    inputTokens += r.inputTokens ?? 0;
    outputTokens += r.outputTokens ?? 0;
    if (r.type === "error") errors += 1;
    if (r.type === "summary") summaries += 1;
    if (r.type === "note" && typeof r.output === "string" && r.output.startsWith("stuck loop:")) {
      stuckNotices += 1;
    }
    if (r.type === "action") actions += 1;
    if ((r.ts ?? 0) > lastTs) lastTs = r.ts;
  }

  const journalFile = join(RUN_DIR, "memory", "journal.md");

  return {
    at: new Date().toISOString(),
    actions,
    errors,
    summaries,
    stuckNotices,
    costUsd: Number(costUsd.toFixed(6)),
    inputTokens,
    outputTokens,
    idleMinutes: lastTs ? Number(((Date.now() - lastTs) / 60000).toFixed(2)) : -1,
    journalBytes: existsSync(journalFile) ? statSync(journalFile).size : 0,
    journalEntries: journalEntries(journalFile),
    workspaceFiles: countFiles(join(RUN_DIR, "workspace")),
    screenshots: countScreenshots(join(RUN_DIR, "logs", "screenshots")),
    processAlive: agentAlive,
    state,
  };
}

function writeReport(): void {
  const samples = existsSync(join(RUN_DIR, "samples.jsonl"))
    ? readJsonl(join(RUN_DIR, "samples.jsonl"))
    : [];
  const last = samples[samples.length - 1] as Sample | undefined;

  // Tool usage distribution, which is the actual answer to "what did it do".
  const records = readJsonl(join(RUN_DIR, "logs", "actions.jsonl"));
  const tools: Record<string, number> = {};
  let errors: Record<string, number> = {};
  for (const r of records) {
    if (r.type === "action" && r.tool) tools[r.tool] = (tools[r.tool] ?? 0) + 1;
    if (r.type === "error") {
      const key = String(r.output ?? "").slice(0, 120);
      errors[key] = (errors[key] ?? 0) + 1;
    }
  }

  const journal = existsSync(join(RUN_DIR, "memory", "journal.md"))
    ? readFileSync(join(RUN_DIR, "memory", "journal.md"), "utf8")
    : "";
  const goals = existsSync(join(RUN_DIR, "memory", "goals.md"))
    ? readFileSync(join(RUN_DIR, "memory", "goals.md"), "utf8")
    : "";

  const autoSummaries = (journal.match(/auto summary/g) ?? []).length;

  const report = {
    runId: RUN_ID,
    startedAt: samples[0]?.at ?? null,
    finishedAt: new Date().toISOString(),
    plannedMinutes: MINUTES,
    samplesTaken: samples.length,
    totals: last
      ? {
          actions: last.actions,
          errors: last.errors,
          summaries: last.summaries,
          stuckNotices: last.stuckNotices,
          costUsd: last.costUsd,
          inputTokens: last.inputTokens,
          outputTokens: last.outputTokens,
          journalEntries: last.journalEntries,
          workspaceFiles: last.workspaceFiles,
          screenshots: last.screenshots,
        }
      : null,
    toolUsage: tools,
    topErrors: Object.entries(errors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
    journal: {
      bytes: journal.length,
      entries: journalEntries(join(RUN_DIR, "memory", "journal.md")),
      autoSummaries,
      tail: journal.slice(-4000),
    },
    goalsRewritten: goals !== readFileSync(join(ROOT, "memory", "goals.md"), "utf8"),
    state: last?.state ?? {},
  };

  writeFileSync(
    join(RUN_DIR, "report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  console.log("\n=== SOAK REPORT ===");
  console.log(JSON.stringify(report, null, 2).slice(0, 4000));
  console.log(`\nfull report: ${join(RUN_DIR, "report.json")}`);
}

function main(): void {
  const envFile = join(ROOT, ".env");
  if (!existsSync(envFile)) {
    console.error("no .env found. Copy .env.example and set MODEL_API_KEY.");
    process.exit(1);
  }

  if (!RESUME) {
    rmSync(RUN_DIR, { recursive: true, force: true });
  }
  for (const dir of ["workspace", "memory", "logs", "logs/screenshots"]) {
    mkdirSync(join(RUN_DIR, dir), { recursive: true });
  }

  // Seed goals so the agent starts from the same place every run.
  const seedGoals = join(ROOT, "memory", "goals.md");
  const seeded = join(RUN_DIR, "memory", "goals.md");
  if (!RESUME || !existsSync(seeded)) {
    writeFileSync(seeded, readFileSync(seedGoals, "utf8"), "utf8");
  }

  console.log(`run ${RUN_ID}`);
  console.log(`dir  ${RUN_DIR}`);
  console.log(`plan ${MINUTES} minutes, sampling every ${SAMPLE_SECONDS}s`);

  const runEnv = {
    ...process.env,
    ENV_FILE: envFile,
    WORKSPACE_DIR: join(RUN_DIR, "workspace"),
    MEMORY_DIR: join(RUN_DIR, "memory"),
    LOGS_DIR: join(RUN_DIR, "logs"),
    STOP_FILE: join(RUN_DIR, "STOP"),
    STATE_FILE: join(RUN_DIR, "memory", "state.json"),
    JOURNAL_FILE: join(RUN_DIR, "memory", "journal.md"),
    ACTIONS_FILE: join(RUN_DIR, "logs", "actions.jsonl"),
    TEMPLATE_DIR: join(ROOT, "web", "templates"),
    RUN_DURATION: `${MINUTES}m`,
  };

  const binary = join(RUN_DIR, "supervisor");
  const build = spawn("go", ["build", "-o", binary, "./cmd/supervisor"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  build.on("close", (code) => {
    if (code !== 0) {
      console.error("go build failed");
      process.exit(2);
    }
    startAll(runEnv, binary);
  });
}

function startAll(runEnv: Record<string, string>, binary: string): void {
  const agent = spawn("node", ["cmd/agent/main.ts"], {
    cwd: ROOT,
    env: runEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(agent);

  const supervisor = spawn(binary, [], {
    cwd: ROOT,
    env: runEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(supervisor);

  const samplesFile = join(RUN_DIR, "samples.jsonl");
  const deadline = Date.now() + MINUTES * 60_000;
  let agentAlive = true;
  agent.on("exit", (code) => {
    agentAlive = false;
    console.log(`agent exited with code ${code}`);
  });

  const tick = async (): Promise<void> => {
    const s = sample(agentAlive);
    writeFileSync(samplesFile, JSON.stringify(s) + "\n", { flag: "a", encoding: "utf8" });
    const mins = s.idleMinutes < 0 ? "n/a" : s.idleMinutes.toFixed(1);
    console.log(
      `[${s.at}] actions=${s.actions} errors=${s.errors} summaries=${s.summaries} ` +
        `stuck=${s.stuckNotices} cost=$${s.costUsd.toFixed(4)} idle=${mins}m ` +
        `journal=${s.journalEntries} files=${s.workspaceFiles} alive=${s.processAlive}`,
    );
  };

  void tick();

  const interval = setInterval(() => void tick(), SAMPLE_SECONDS * 1000);

  // Watchdog for the harness itself: an agent that dies silently must be
  // reported, not left to look like a healthy idle run.
  const heartbeat = setInterval(() => {
    if (!agentAlive) {
      console.error("agent is not running; ending the soak so the failure is visible");
      clearInterval(interval);
      clearInterval(heartbeat);
      shutdown();
      writeReport();
      process.exit(3);
    }
  }, 60_000);

  setTimeout(() => {
    console.log("\nplanned duration reached");
    clearInterval(interval);
    clearInterval(heartbeat);
    try {
      writeFileSync(join(RUN_DIR, "STOP"), "soak duration reached\n", "utf8");
    } catch {
      // Best effort; the agent also stops on its own deadline.
    }
    setTimeout(() => {
      shutdown();
      void tick();
      writeReport();
      process.exit(0);
    }, 15_000);
  }, Math.max(0, deadline - Date.now()));

  void sleep(1);
}

main();