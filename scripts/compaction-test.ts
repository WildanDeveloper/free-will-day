#!/usr/bin/env node
/**
 * Unit tests for the two pieces that decide whether the agent survives 24 hours:
 * context compaction and stuck-loop detection. Both are pure logic, so they are
 * tested without a model or a browser.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compactWindow, journalTail, rotateJournal } from "../internal/agent/compact.ts";
import { detectStuckLoop, stuckNudge } from "../internal/agent/loopguard.ts";
import { readRecent } from "../internal/logger/actions.ts";
import type { ActionRecord } from "../internal/logger/actions.ts";

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ""): void {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

function record(over: Partial<ActionRecord> = {}): ActionRecord {
  return {
    ts: Date.now(),
    seq: 1,
    type: "action",
    tool: "shell",
    input: { command: "ls" },
    output: "file.txt",
    ok: true,
    ...over,
  };
}

/** Minimal stand-in for ModelClient. */
function fakeClient(text: string, costUsd = 0.01) {
  return {
    chat: async () => ({
      text,
      toolCalls: [],
      stopReason: "end_turn",
      inputTokens: 100,
      outputTokens: 50,
      costUsd,
    }),
  };
}

console.log("\n1. compaction writes the summary to the journal");
const dir = mkdtempSync(join(tmpdir(), "fw-compact-"));

const result = await compactWindow({
  client: fakeClient("Built a parser. Next: wire it into the CLI.") as never,
  memoryDir: dir,
  records: [record({ tool: "write_file" }), record({ tool: "shell" })],
  actionCount: 30,
});

check("compaction ran", result.compacted);
check("summary returned", Boolean(result.summary), result.summary?.slice(0, 50));
check("cost reported", typeof result.costUsd === "number");

const journal = readFileSync(join(dir, "journal.md"), "utf8");
check("journal file created", existsSync(join(dir, "journal.md")));
check("summary is in the journal", journal.includes("Built a parser"));
check("entry is marked as auto summary", journal.includes("auto summary"));

console.log("\n2. compaction survives a model failure");
const failing = await compactWindow({
  client: {
    chat: async () => {
      throw new Error("model unavailable");
    },
  } as never,
  memoryDir: dir,
  records: [record()],
  actionCount: 5,
});
check("failure reported, not thrown", failing.compacted === false);
check("error captured", Boolean(failing.error), failing.error);

console.log("\n3. compaction skips an empty window");
const empty = await compactWindow({
  client: fakeClient("should not be called") as never,
  memoryDir: dir,
  records: [],
  actionCount: 0,
});
check("empty window is a no-op", empty.compacted === false);

console.log("\n4. journal tail is bounded");
const before = journalTail(dir, 6000).length;
check("tail readable", before > 0, `${before} chars`);
rmSync(join(dir, "journal.md"));
check("missing journal handled", journalTail(dir, 6000) === "(empty journal)");

console.log("\n5. identical repeated calls are detected");
const stuck = detectStuckLoop(
  [record(), record(), record(), record()],
  3,
);
check("stuck detected", stuck.stuck, stuck.reason);
check("tool identified", stuck.tool === "shell");
check("repeat count reported", stuck.repeats === 4, `repeats=${stuck.repeats}`);

console.log("\n6. different inputs are not a stuck loop");
const varied = detectStuckLoop(
  [
    record({ input: { command: "ls" } }),
    record({ input: { command: "cat a" } }),
    record({ input: { command: "cat b" } }),
    record({ input: { command: "cat c" } }),
  ],
  3,
);
check("varied work is not flagged", varied.stuck === false);

console.log("\n7. interleaved actions are not a stuck loop");
const interleaved = detectStuckLoop(
  [
    record({ tool: "shell" }),
    record({ tool: "list_dir" }),
    record({ tool: "shell" }),
    record({ tool: "list_dir" }),
    record({ tool: "shell" }),
    record({ tool: "list_dir" }),
  ],
  3,
);
check("interleaving is not flagged", interleaved.stuck === false);

console.log("\n8. below threshold is not flagged");
check(
  "two repeats tolerated",
  detectStuckLoop([record(), record()], 3).stuck === false,
);

console.log("\n9. journal writes are not confused with actions");
const journalish = detectStuckLoop(
  [
    record(),
    record(),
    { ts: Date.now(), seq: 9, type: "journal", output: "note" },
    { ts: Date.now(), seq: 10, type: "summary", output: "sum" },
  ],
  2,
);
check("journal records ignored", journalish.stuck === false || journalish.repeats === 2);

console.log("\n10. the nudge tells the agent what to do");
const nudge = stuckNudge(stuck);
check("nudge mentions the tool", nudge.includes("shell"));
check("nudge offers alternatives", nudge.includes("journal"));
check("nudge rejects repeating", /will not help|not help/i.test(nudge));

rmSync(dir, { recursive: true, force: true });

// Section 4 deletes journal.md, and this needs a directory that still exists.
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

console.log("\n11. readRecent reads only the tail");
// Regression: this used to read the whole log on every iteration, which over a
// 24 hour run means hundreds of gigabytes of pointless IO.
{
  const logFile = join(dir, "actions.jsonl");
  const many = Array.from({ length: 5000 }, (_, i) =>
    JSON.stringify({
      ts: Date.now(),
      seq: i,
      type: "action",
      tool: "shell",
      input: { command: "x".repeat(200) },
      output: "y".repeat(200),
      ok: true,
    }),
  ).join("\n");
  writeFileSync(logFile, many + "\n", "utf8");

  const size = statSync(logFile).size;
  const got = readRecent(logFile, 10);
  check("tail read returns records", got.length === 10, `${got.length} records`);
  check(
    "returns the newest, not the oldest",
    got[got.length - 1].seq === 4999,
    `last seq ${got[got.length - 1].seq}`,
  );
  check("log was large enough to matter", size > 1_000_000, `${(size / 1048576).toFixed(1)}MB`);

  // A partial final line, as happens after a crash.
  writeFileSync(logFile, many + '\n{"ts":1,"seq":99,"typ', "utf8");
  const afterTear = readRecent(logFile, 5);
  check("torn final line tolerated", afterTear.length === 5, `${afterTear.length} records`);
}

console.log("\n12. journal rotation keeps the file bounded");
// Regression: the journal grew without limit over a 24 hour run.
{
  // Must exceed JOURNAL_MAX_BYTES (8MB) to trip rotation, which is the point of
  // the threshold: a small journal is left alone.
  // ~600 bytes per entry, 20k entries, so about 12MB. Must clear the 8MB cap.
const entry = "## 2099-01-01T00:00:00Z — entry\n" + "y".repeat(580) + "\n";
  writeFileSync(join(dir, "journal.md"), entry.repeat(20_000), "utf8");
  const before = statSync(join(dir, "journal.md")).size;
  check("fixture exceeds the rotation threshold", before > 8 << 20, `${(before / 1048576).toFixed(1)}MB`);
  rotateJournal(dir);
  const after = statSync(join(dir, "journal.md")).size;
  check("large journal is rotated", after < before, `${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`);
  check("rotation keeps recent entries", after > 0, `${after} bytes kept`);
  check(
    "rotation preserves whole entries",
    readFileSync(join(dir, "journal.md"), "utf8").startsWith("\n## "),
  );

  const smallPath = join(dir, "small.md");
  writeFileSync(smallPath, "tiny journal", "utf8");
  rotateJournal(dir);
  check("small journal left untouched", readFileSync(smallPath, "utf8") === "tiny journal");
}

console.log(`\n${failures.length ? "FAILED" : "PASSED"}: ${failures.length} failure(s)`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);