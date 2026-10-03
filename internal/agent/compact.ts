/**
 * Real context compaction.
 *
 * The loop does not keep a growing conversation. Every iteration builds a
 * fresh prompt from durable state: goals.md, the journal, and a bounded window
 * of recent actions. When that window fills up, the agent asks the model to
 * summarize what actually happened, the summary is written to the journal, and
 * the window is dropped.
 *
 * The alternative, silently truncating history, is how an agent forgets its
 * own goal six hours into a run: the summary is what preserves intent.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { ModelClient } from "../llm/client.ts";
import type { ActionRecord } from "../logger/actions.ts";

export type CompactionResult = {
  /** True when a summary was requested and written. */
  compacted: boolean;
  /** Characters of journal tail the next prompt will see. */
  journalChars: number;
  summary?: string;
  costUsd?: number;
  error?: string;
};

/**
 * Compact a bounded window of actions into the journal. Called when the recent
 * window grows past `every`, not on a timer, so cost scales with work done.
 */
export async function compactWindow(opts: {
  client: ModelClient;
  memoryDir: string;
  records: ActionRecord[];
  /** Actions since the last compaction. */
  actionCount: number;
}): Promise<CompactionResult> {
  const { client, memoryDir, records, actionCount } = opts;

  if (!records.length) {
    return { compacted: false, journalChars: 0 };
  }

  const transcript = records
    .map((r) => {
      const stamp = new Date(r.ts).toISOString().slice(11, 19);
      const tool = r.tool || r.type;
      const status = r.ok === undefined ? "" : r.ok ? "" : " (failed)";
      const out = (r.output || "").slice(0, 400);
      return `[${stamp}] ${tool}${status}\n${out}`;
    })
    .join("\n\n");

  const prompt =
    `Write a note to yourself for later. The conversation is about to be\n` +
    `discarded and only this will survive.\n\n` +
    `Write for someone who has no memory of the stretch below. If nothing\n` +
    `worth recording happened, say that in one line. Do not manufacture\n` +
    `interest, and do not pretend you were busy if you were not.\n\n` +
    `If there is anything to record, you might mention what happened, whether\n` +
    `it worked, and what you felt like doing next. There is no requirement to\n` +
    `have a plan.\n\n` +
    `## the stretch (${actionCount} actions)\n${transcript}`;

  let summary: string;
  let costUsd: number;
  try {
    const result = await client.chat({
      system:
        "You are the same agent that performed these actions. Write a short " +
        "note to yourself in plain text. Honesty matters more than length: if " +
        "the stretch was empty or repetitive, say so.",
      messages: [{ role: "user", content: prompt }],
      tools: [],
      maxTokens: 1024,
    });
    summary = result.text.trim();
    costUsd = result.costUsd;
  } catch (err) {
    return {
      compacted: false,
      journalChars: 0,
      error: (err as Error).message,
    };
  }

  if (!summary) {
    return { compacted: false, journalChars: 0, error: "empty summary" };
  }

  appendJournal(memoryDir, summary);

  return {
    compacted: true,
    journalChars: journalTail(memoryDir, 6000).length,
    summary: summary.slice(0, 4000),
    costUsd,
  };
}

/** Read the tail of journal.md, bounded so the prompt stays a fixed size. */
export function journalTail(memoryDir: string, max: number): string {
  const path = join(memoryDir, "journal.md");
  if (!existsSync(path)) return "(empty journal)";
  try {
    const full = readFileSync(path, "utf8");
    return full.length > max ? full.slice(full.length - max) : full;
  } catch {
    return "(journal unreadable)";
  }
}

export function appendJournal(memoryDir: string, entry: string): void {
  const stamp = new Date().toISOString();
  appendFileSync(
    join(memoryDir, "journal.md"),
    `\n## ${stamp} — auto summary\n${entry.trim()}\n`,
    "utf8",
  );
  rotateJournal(memoryDir);
}

/**
 * Keep the journal from growing without bound over a 24 hour run. Only the
 * newest portion is ever read into a prompt, so older text is dead weight on
 * disk and a wasted read. One generation is kept.
 */
const JOURNAL_MAX_BYTES = 8 << 20; // 8MB

export function rotateJournal(memoryDir: string): void {
  const path = join(memoryDir, "journal.md");
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= JOURNAL_MAX_BYTES) return;

  try {
    const full = readFileSync(path, "utf8");
    // Cut at a heading so entries are not left half-written.
    const cut = full.lastIndexOf("\n## ", full.length - JOURNAL_MAX_BYTES / 2);
    const kept = cut > 0 ? full.slice(cut) : full.slice(-JOURNAL_MAX_BYTES / 2);
    writeFileSync(path, kept, "utf8");
  } catch {
    // Rotation is best effort; a failure here must not stop the run.
  }
}

/**
 * How many characters of journal to put in the prompt. Grows with the journal
 * up to a cap, so early runs are not padded with empty history.
 */
export function journalWindow(memoryDir: string): string {
  const tail = journalTail(memoryDir, 6000);
  return tail;
}