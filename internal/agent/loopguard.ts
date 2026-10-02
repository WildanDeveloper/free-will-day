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
 * Look for repetition in the recent window.
 *
 * Two shapes are caught, because an agent gets stuck in both:
 *
 * 1. the same call repeated outright, and
 * 2. a short cycle repeated, e.g. "ls, cat goals, say nothing" over and over.
 *    A strict consecutive test misses this entirely, which is exactly how a real
 *    2 hour run spent its first minutes re-reading its own goals.
 *
 * Also treats "spoke without acting" as an action worth counting: an agent that
 * keeps promising to start and never starts is the most common failure here.
 */
export function detectStuckLoop(
  records: ActionRecord[],
  threshold: number,
): LoopVerdict {
  const actions = records.filter((r) => r.type === "action" && r.tool);
  if (actions.length < threshold) return { stuck: false, reason: "" };

  const window = actions.slice(-Math.max(threshold * 6, 24));
  const keyOf = (rec: ActionRecord) =>
    `${rec.tool}:${fingerprint(rec.input)}`;

  // 1. Identical calls, consecutive.
  let run = 1;
  for (let i = window.length - 1; i > 0; i -= 1) {
    if (keyOf(window[i]) === keyOf(window[i - 1])) run += 1;
    else break;
  }
  if (run >= threshold) {
    const last = window[window.length - 1];
    return {
      stuck: true,
      tool: last.tool,
      repeats: run,
      reason: `${last.tool} called ${run} times with identical input`,
    };
  }

  // 2. A repeated cycle of 2 to 4 distinct steps.
  for (let size = 2; size <= 4; size += 1) {
    const tail = window.slice(-size * 3);
    if (tail.length < size * 2) continue;

    const cycle = tail.slice(0, size).map(keyOf);
    let repeats = 1;
    for (let i = size; i + size <= tail.length; i += size) {
      const candidate = tail.slice(i, i + size).map(keyOf);
      if (candidate.every((k, j) => k === cycle[j])) repeats += 1;
      else break;
    }
    if (repeats >= 3) {
      const steps = tail
        .slice(0, size)
        .map((r) => r.tool)
        .join(" -> ");
      return {
        stuck: true,
        tool: tail[0].tool,
        repeats: repeats * size,
        reason: `repeating a ${size}-step cycle (${steps}) ${repeats} times`,
      };
    }
  }

  return { stuck: false, reason: "" };
}

/**
 * A separate signal from the tool loop: an agent that keeps answering in prose
 * and never calling a tool. Counted over the whole window rather than
 * consecutively, since real stuck behaviour interleaves tools with talk.
 */
export function detectIdleTalking(
  records: ActionRecord[],
  window: number,
  ratio = 0.25,
): LoopVerdict {
  const actions = records.filter((r) => r.type === "action" && r.tool);
  if (actions.length < 5) return { stuck: false, reason: "" };

  const recent = actions.slice(-window);
  const silent = recent.filter((r) => r.tool === "(no tool call)").length;
  // A third of turns producing no action is already a real problem: the agent
  // is narrating progress instead of making it.
  if (recent.length >= 5 && silent / recent.length >= ratio) {
    return {
      stuck: true,
      tool: "(no tool call)",
      repeats: silent,
      reason: `${silent} of the last ${recent.length} actions produced text but no action`,
    };
  }
  return { stuck: false, reason: "" };
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