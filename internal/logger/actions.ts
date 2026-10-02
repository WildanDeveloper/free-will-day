/**
 * Append-only action log. One JSON object per line, written with a single
 * write() call so a line is never interleaved with another writer.
 *
 * Format contract shared with the Go supervisor: every record carries at least
 * ts, type, and seq. The supervisor tolerates unknown fields.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type ActionRecord = {
  /** Unix milliseconds. */
  ts: number;
  /** Monotonic counter, survives restarts via the state file. */
  seq: number;
  type: "action" | "journal" | "summary" | "note" | "error";
  /** The model's stated reasoning, when available. */
  thought?: string;
  tool?: string;
  input?: unknown;
  output?: string;
  ok?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Set on a refusal to continue. */
  haltReason?: string;
};

export class ActionLog {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
  }

  write(record: ActionRecord): void {
    appendFileSync(this.file, JSON.stringify(record) + "\n", "utf8");
  }

  path(): string {
    return this.file;
  }
}

/** Read the last n records. Used to rebuild context after a restart. */
export function readRecent(file: string, n: number): ActionRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean);
  const out: ActionRecord[] = [];
  for (const line of lines.slice(-n * 4)) {
    try {
      out.push(JSON.parse(line) as ActionRecord);
    } catch {
      // A partially flushed final line is expected after a crash. Skip it.
    }
  }
  return out.slice(-n);
}