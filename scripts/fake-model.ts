#!/usr/bin/env node
/**
 * Fake model server. Implements enough of the Anthropic wire format to let the
 * agent loop run end to end without spending money or needing a real key.
 *
 * It replays a scripted sequence of tool calls, then keeps answering with a
 * journal entry. Used by `npm run smoke`.
 */

import { createServer } from "node:http";

interface FakeState {
  calls: number;
  stopped: boolean;
}

let state: FakeState = { calls: 0, stopped: false };

function scriptedResponse(step: number): Record<string, unknown> {
  const script: unknown[][] = [
    [{ type: "text", text: "Starting. Let me look at the workspace first." }],
    [
      {
        type: "tool_use",
        id: `call_${step}`,
        name: "list_dir",
        input: { path: "." },
      },
    ],
    [
      {
        type: "tool_use",
        id: `call_${step}`,
        name: "write_file",
        input: {
          path: "notes/hello.md",
          content: `# Hello\n\nWritten at step ${step} by the fake model.\n`,
        },
      },
    ],
    [
      {
        type: "tool_use",
        id: `call_${step}`,
        name: "shell",
        input: { command: "echo smoke-test && date -u +%FT%TZ" },
      },
    ],
    [
      {
        type: "tool_use",
        id: `call_${step}`,
        name: "write_journal",
        input: {
          entry:
            `Step ${step}. Created notes/hello.md, verified the shell works. ` +
            `Next: keep building or stop the loop via the dashboard.`,
        },
      },
    ],
  ];

  // FAKE_REPEAT_TOOL=1 makes every turn the same identical call, which is what
  // the stuck-loop detector is supposed to catch.
  if (process.env.FAKE_REPEAT_TOOL === "1") {
    return {
      content: [
        {
          type: "tool_use",
          id: `r${step}`,
          name: "shell",
          input: { command: "echo stuck-loop" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 400, output_tokens: 40 },
    };
  }

  const turn = script[step % script.length] as Record<string, unknown>[];

  return {
    content: turn,
    stop_reason: turn.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: 1200 + step * 7, output_tokens: 180 + step * 3 },
  };
}

/** Script used when FAKE_BROWSER_SCRIPT=1: drives the browser tool. */
function browserScript(step: number): Record<string, unknown> {
  const turns: Record<string, unknown>[] = [
    {
      type: "tool_use",
      id: `b${step}`,
      name: "browser",
      input: { action: "open", url: process.env.FAKE_PAGE_URL ?? "http://127.0.0.1:8123/" },
    },
    {
      type: "tool_use",
      id: `b${step}`,
      name: "browser",
      input: { action: "read" },
    },
    {
      type: "tool_use",
      id: `b${step}`,
      name: "browser",
      input: { action: "type", selector: "#name", text: "freewillday" },
    },
    {
      type: "tool_use",
      id: `b${step}`,
      name: "browser",
      input: { action: "click", selector: "#go" },
    },
    {
      type: "tool_use",
      id: `b${step}`,
      name: "browser",
      input: { action: "read" },
    },
    {
      type: "tool_use",
      id: `b${step}`,
      name: "write_journal",
      input: { entry: `Browser turn ${step}. Page read, form submitted.` },
    },
  ];

  // step - 1 so the first turn is `open`, not `read`.
  const turn = [turns[(step - 1) % turns.length]];
  return {
    content: turn,
    stop_reason: "tool_use",
    usage: { input_tokens: 900 + step * 5, output_tokens: 120 + step },
  };
}

const server = createServer((req, res) => {
  // Readiness probe. Deliberately does not advance the script: a probe must
  // not consume a turn the agent is meant to see.
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, calls: state.calls }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    let parsed: any = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      parsed = {};
    }

    // Basic auth check: the agent must send credentials when they are set.
    const auth = req.headers.authorization ?? "";
    if (process.env.FAKE_REQUIRE_BASIC === "1" && !auth.startsWith("Basic ")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "basic auth required" }));
      return;
    }

    state.calls += 1;

    // Compaction calls the model with no tools and asks for prose. A real model
    // summarises here; the fake must do the same, or compaction can never be
    // exercised. Detection is on the tool list being absent, which is the actual
    // signal: an empty tools array means this cannot be a normal turn.
    const isCompaction = Array.isArray(parsed?.tools) && parsed.tools.length === 0;

    let payload: Record<string, unknown>;
    if (isCompaction) {
      payload = {
        content: [
          {
            type: "text",
            text:
              `Auto summary at call ${state.calls}: repeatedly ran the same shell ` +
              `command and got the same output. Nothing changed state. Next: try a ` +
              `different tool or write the blocker down.`,
          },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 700, output_tokens: 90 },
      };
    } else if (process.env.FAKE_BROWSER_SCRIPT === "1") {
      payload = browserScript(state.calls);
    } else {
      payload = scriptedResponse(state.calls);
    }

    console.error(`[fake-model] call ${state.calls} -> ${JSON.stringify(payload.content)}`);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});

const port = Number(process.env.FAKE_MODEL_PORT ?? 8099);
server.listen(port, "127.0.0.1", () => {
  console.error(`[fake-model] listening on http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}