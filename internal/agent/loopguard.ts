/**
 * Stuck-loop detection.
 *
 * The supervisor already reports repeated tool usage on the dashboard, but that
 * is a human-facing signal. This module feeds the agent a nudge directly, which
 * is the only thing that can actually change its next action.
 *
 * Detection is on the tool name plus a hash of the input, so genuinely
 * repeated identical calls are distinguished from the same tool used with
 * different arguments, which may be perfectly productive.
 */

import { createHash } from "node:crypto";
import type { ActionRecord } from "../logger/actions.ts";

export type LoopVerdict = {
  /** A nudge should be injected into the next prompt. */
  stuck: boolean;
  /** The tool being repeated. */
  tool?: string;
  /** How many identical calls were seen in the window. */
  repeats?: number;
  /** Human-readable explanation for the dashboard and the log. */
  reason: string;
};

/** Short stable hash of the input, so the log stays readable. */
function fingerprint(input: unknown): string {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? null);
  return createHash("sha1").update(text.slice(0, 2000)).digest("hex").slice(0, 10);
}

/**
 * Look for the same tool called with the same input repeatedly in the window.
 * `threshold` identical calls in a row is the trigger.
 */
export function detectStuckLoop(
  records: ActionRecord[],
  threshold: number,
): LoopVerdict {
  const actions = records.filter((r) => r.type === "action" && r.tool);
  if (actions.length < threshold) {
    return { stuck: false, reason: "" };
  }

  const window = actions.slice(-Math.max(threshold * 2, 20));
  const counts = new Map<string, { tool: string; count: number }>();

  for (const rec of window) {
    const key = `${rec.tool}:${fingerprint(rec.input)}`;
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(key, { tool: rec.tool as string, count: 1 });
    }
  }

  let worst: { tool: string; count: number } | null = null;
  for (const entry of counts.values()) {
    if (!worst || entry.count > worst.count) worst = entry;
  }

  // Only consecutive repetition counts. Interleaved distinct actions mean the
  // agent is busy, not stuck.
  if (!worst || worst.count < threshold) {
    return { stuck: false, reason: "" };
  }

  const lastKey = `${window[window.length - 1].tool}:${fingerprint(window[window.length - 1].input)}`;
  const tail = window.slice(-threshold);
  const consecutive = tail.every(
    (rec) => `${rec.tool}:${fingerprint(rec.input)}` === lastKey,
  );

  if (!consecutive) {
    return { stuck: false, reason: "" };
  }

  return {
    stuck: true,
    tool: worst.tool,
    repeats: worst.count,
    reason: `${worst.tool} called ${worst.count} times with identical input`,
  };
}

/** The nudge text injected into the prompt when a loop is detected. */
export function stuckNudge(verdict: LoopVerdict): string {
  return (
    `Note: the last ${verdict.repeats} actions were all ${verdict.tool} with ` +
    `identical input, and they did not change anything. Repeating it again will ` +
    `not help.\n\n` +
    `Do one of these instead:\n` +
    `1. Write to the journal what is actually blocking you.\n` +
    `2. Try a different approach, and say what you expect to be different.\n` +
    `3. Do nothing further on this and pick something else entirely.\n\n` +
    `Sitting with a stuck problem and writing it down is a legitimate outcome.`
  );
}