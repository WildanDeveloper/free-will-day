/**
 * The tool surface exposed to the model. Four tools, deliberately minimal.
 *
 * Path resolution is contained: every relative path is resolved against the
 * memory or workspace root and rejected if it escapes. Absolute paths outside
 * those roots are rejected too.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ToolSpec } from "../llm/client.ts";

export type ToolContext = {
  workspaceDir: string;
  memoryDir: string;
  logsDir: string;
  maxOutput: number;
  /** Wall-clock limit for a single shell command. */
  shellTimeoutMs: number;
};

export type ToolOutcome = {
  output: string;
  ok: boolean;
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "shell",
    description:
      "Run a shell command. Working directory is the workspace. " +
      "Use for exploration, building, testing, git, package installs.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line to execute" },
        timeout_ms: {
          type: "number",
          description: "Optional timeout override in milliseconds",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 file from the workspace or memory directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 file, creating parent directories as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        append: { type: "boolean", description: "Append instead of overwrite" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "List a directory with size and modification time per entry.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_journal",
    description:
      "Append a dated entry to journal.md. Required at least once per hour and " +
      "whenever something notable happens.",
    parameters: {
      type: "object",
      properties: { entry: { type: "string" } },
      required: ["entry"],
    },
  },
];

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `${text.slice(0, max)}\n... [truncated ${dropped} chars]`;
}

/** Resolve a model-supplied path inside an allowed root, or return null. */
export function resolveInside(root: string, candidate: string): string | null {
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

export async function runShell(
  ctx: ToolContext,
  command: string,
  timeoutMs?: number,
): Promise<ToolOutcome> {
  const limit = Math.min(timeoutMs ?? ctx.shellTimeoutMs, 600_000);
  return await new Promise<ToolOutcome>((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: ctx.workspaceDir,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: ctx.workspaceDir,
        LANG: "C.UTF-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, limit);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const finish = (ok: boolean, output: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output });
    };

    child.on("error", (err: Error) => finish(false, `spawn error: ${err.message}`));
    child.on("close", (code: number) => {
      const parts = [];
      if (stdout.trim()) parts.push(stdout.trimEnd());
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
      if (!parts.length) parts.push(`(no output, exit ${code})`);
      finish(code === 0, truncate(parts.join("\n"), ctx.maxOutput));
    });
  });
}

export function readFile(ctx: ToolContext, path: string): ToolOutcome {
  const abs =
    resolveInside(ctx.workspaceDir, path) ?? resolveInside(ctx.memoryDir, path);
  if (!abs) {
    return { ok: false, output: `path outside workspace and memory: ${path}` };
  }
  try {
    const text = readFileSync(abs, "utf8");
    return { ok: true, output: truncate(text, ctx.maxOutput) };
  } catch (err) {
    return { ok: false, output: `read failed: ${(err as Error).message}` };
  }
}

export function writeFile(
  ctx: ToolContext,
  path: string,
  content: string,
  append: boolean,
): ToolOutcome {
  const abs =
    resolveInside(ctx.workspaceDir, path) ?? resolveInside(ctx.memoryDir, path);
  if (!abs) {
    return { ok: false, output: `path outside workspace and memory: ${path}` };
  }
  try {
    mkdirSync(dirname(abs), { recursive: true });
    if (append) appendFileSync(abs, content, "utf8");
    else writeFileSync(abs, content, "utf8");
    return { ok: true, output: `wrote ${Buffer.byteLength(content)} bytes to ${abs}` };
  } catch (err) {
    return { ok: false, output: `write failed: ${(err as Error).message}` };
  }
}

export function listDir(ctx: ToolContext, path: string): ToolOutcome {
  const abs =
    resolveInside(ctx.workspaceDir, path) ?? resolveInside(ctx.memoryDir, path);
  if (!abs) {
    return { ok: false, output: `path outside workspace and memory: ${path}` };
  }
  try {
    const entries = readdirSync(abs, { withFileTypes: true }).map((e) => {
      const full = join(abs, e.name);
      let detail = "";
      if (e.isFile()) {
        const st = statSync(full);
        detail = `${st.size}b ${st.mtime.toISOString().slice(0, 19)}`;
      }
      return `${e.isDirectory() ? "d" : "-"} ${e.name}${detail ? `  ${detail}` : ""}`;
    });
    return {
      ok: true,
      output: truncate(entries.length ? entries.join("\n") : "(empty)", ctx.maxOutput),
    };
  } catch (err) {
    return { ok: false, output: `list failed: ${(err as Error).message}` };
  }
}

export function writeJournal(ctx: ToolContext, entry: string): ToolOutcome {
  const stamp = new Date().toISOString();
  const block = `\n## ${stamp}\n${entry.trim()}\n`;
  try {
    mkdirSync(ctx.memoryDir, { recursive: true });
    appendFileSync(join(ctx.memoryDir, "journal.md"), block, "utf8");
    return { ok: true, output: `journal updated at ${stamp}` };
  } catch (err) {
    return { ok: false, output: `journal write failed: ${(err as Error).message}` };
  }
}

/** Dispatch a tool call by name. Unknown names fail loudly. */
export async function dispatch(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  switch (name) {
    case "shell":
      return await runShell(
        ctx,
        String(input.command ?? ""),
        typeof input.timeout_ms === "number" ? input.timeout_ms : undefined,
      );
    case "read_file":
      return readFile(ctx, String(input.path ?? ""));
    case "write_file":
      return writeFile(
        ctx,
        String(input.path ?? ""),
        String(input.content ?? ""),
        Boolean(input.append),
      );
    case "list_dir":
      return listDir(ctx, String(input.path ?? "."));
    case "write_journal":
      return writeJournal(ctx, String(input.entry ?? ""));
    default:
      return { ok: false, output: `unknown tool: ${name}` };
  }
}