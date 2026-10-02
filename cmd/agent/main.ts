#!/usr/bin/env node
/**
 * Agent entrypoint. Wires config, runs the loop, exits cleanly on any halt so
 * systemd or tmux does not restart a deliberately stopped run.
 */

import { loadDotEnv } from "../../internal/config/config.ts";
import { run } from "../../internal/agent/loop.ts";

loadDotEnv(process.env.ENV_FILE ?? ".env");

try {
  const code = await run();
  process.exit(code);
} catch (err) {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[agent] fatal: ${message}\n`);
  process.exit(1);
}