/**
 * Configuration is read from the environment. All values are optional except the
 * model credentials. Sources: .env if present, then the process environment.
 */

import { readFileSync } from "node:fs";

export type ModelStyle = "openai" | "anthropic";

export type Config = {
  workspaceDir: string;
  memoryDir: string;
  logsDir: string;
  stopFile: string;
  stateFile: string;

  /** Run length, e.g. "24h", "15m". */
  runDuration: string;
  /** Hard cost ceiling in USD. The loop stops itself when it is reached. */
  maxBudgetUsd: number;
  /** Pause between iterations, milliseconds. */
  sleepMs: number;
  /** How many recent actions are included in the prompt. */
  contextActions: number;
  /**
   * Actions between real compactions. At this point the recent-action window
   * is summarised into the journal by the model and then dropped.
   */
  summarizeEvery: number;
  /** Identical consecutive tool calls before the agent is nudged. */
  loopDetectionThreshold: number;
  /**
   * Minutes a single process may run before exiting cleanly, so a supervisor
   * can recycle it mid-run. 0 disables the cap. Resumption is via state.json.
   */
  maxProcessRuntimeMinutes: number;
  /** Mandatory journal entry every N minutes. */
  journalEveryMinutes: number;
  /** Truncate tool output to this many characters before it enters context. */
  maxToolOutput: number;

  modelId: string;
  modelBaseUrl: string;
  modelApiKey: string;
  modelStyle: ModelStyle;
  /** Optional basic auth for a custom endpoint. */
  modelBasicUser: string;
  modelBasicPass: string;
  /** USD per 1M tokens, used to price the usage field. */
  priceInputPerM: number;
  priceOutputPerM: number;

  enableBrowser: boolean;
  /** Playwright profile directory, defaults to workspace/.pw */
  browserProfileDir: string;
  /** Background screenshot cadence, minutes. */
  screenshotEveryMinutes: number;
};

function env(key: string): string {
  const value = process.env[key];
  return value === undefined ? "" : value.trim();
}

function num(key: string, fallback: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`config: ${key} is not a number: ${raw}`);
  }
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = env(key).toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function required(key: string): string {
  const value = env(key);
  if (!value) {
    throw new Error(`config: ${key} is required (see .env.example)`);
  }
  return value;
}

export function loadConfig(): Config {
  const workspaceDir = env("WORKSPACE_DIR") || "/workspace";
  const memoryDir = env("MEMORY_DIR") || "/memory";
  const logsDir = env("LOGS_DIR") || "/logs";

  return {
    workspaceDir,
    memoryDir,
    logsDir,
    stopFile: env("STOP_FILE") || "/STOP",
    stateFile: env("STATE_FILE") || `${memoryDir}/state.json`,

    runDuration: env("RUN_DURATION") || "24h",
    maxBudgetUsd: num("MAX_BUDGET_USD", 5),
    sleepMs: num("SLEEP_MS", 2000),
    contextActions: num("CONTEXT_ACTIONS", 20),
    summarizeEvery: num("SUMMARIZE_EVERY", 30),
    loopDetectionThreshold: num("LOOP_DETECTION_THRESHOLD", 3),
    maxProcessRuntimeMinutes: num("MAX_PROCESS_RUNTIME_MINUTES", 0),
    journalEveryMinutes: num("JOURNAL_EVERY_MINUTES", 60),
    maxToolOutput: num("MAX_TOOL_OUTPUT", 4000),

    modelId: env("MODEL_ID") || "claude-sonnet-4-5",
    modelBaseUrl: env("MODEL_BASE_URL"),
    modelApiKey: required("MODEL_API_KEY"),
    modelStyle: (env("MODEL_STYLE") || "anthropic") as ModelStyle,
    modelBasicUser: env("MODEL_BASIC_USER"),
    modelBasicPass: env("MODEL_BASIC_PASS"),
    priceInputPerM: num("PRICE_INPUT_PER_M", 3),
    priceOutputPerM: num("PRICE_OUTPUT_PER_M", 15),

    enableBrowser: bool("ENABLE_BROWSER", false),
    browserProfileDir: env("BROWSER_PROFILE_DIR") || `${workspaceDir}/.pw`,
    screenshotEveryMinutes: num("SCREENSHOT_EVERY_MINUTES", 5),
  };
}

/** Parse "24h" / "90m" / "30s" into milliseconds. */
export function parseDuration(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!match) throw new Error(`invalid duration: ${raw}`);
  const value = Number(match[1]);
  const unit = match[2] ?? "m";
  const scale: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * scale[unit];
}

/**
 * Populate process.env from a .env file. Existing variables win, so real
 * environment configuration is never silently overridden.
 */
export function loadDotEnv(file = ".env"): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}