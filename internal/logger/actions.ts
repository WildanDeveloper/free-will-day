/**
 * Append-only action log. One JSON object per line, written with a single
 * write() call so a line is never interleaved with another writer.
 *
 * Format contract shared with the Go supervisor: every record carries at least
 * ts, type, and seq. The supervisor tolerates unknown fields.
 */

import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
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

/**
 * Read the last n records.
 *
 * Reads only the tail of the file. A 24 hour run produces tens of thousands of
 * records, and reading the whole log on every iteration would mean hundreds of
 * gigabytes of IO for no reason.
 */
export function readRecent(file: string, n: number, tailBytes = 4 << 20): ActionRecord[] {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return [];
  }

  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];

    // A record can be large, so read back further than n records would need.
    const want = Math.min(size, Math.max(tailBytes, n * 4096));
    const buffer = Buffer.allocUnsafe(want);
    const read = readSync(fd, buffer, 0, want, size - want);
    if (read <= 0) return [];

    let text = buffer.toString("utf8", 0, read);
    // The cut point usually lands mid-line; drop the partial first line.
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : text;

    const out: ActionRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as ActionRecord);
      } catch {
        // A partially flushed final line is expected after a crash. Skip it.
      }
    }
    return out.slice(-n);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}