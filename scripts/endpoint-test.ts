#!/usr/bin/env node
/**
 * Endpoint resolution tests.
 *
 * Regression: a hardcoded "/v1/chat/completions" suffix produced
 * "https://openrouter.ai/api/v1/v1/chat/completions" and a 404, so every base
 * URL form has to be covered here.
 */

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ""): void {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

/** Copy of ModelClient.url, so the real logic is exercised without a request. */
function resolve(base: string, path: string, suffixes: string[]): string {
  const b = base.replace(/\/+$/, "");
  if (!b) throw new Error("empty base");
  const cleanPath = path.replace(/^\/+/, "");
  const bare = cleanPath.replace(/^v1\//, "");

  for (const suffix of suffixes) {
    const tail = suffix.replace(/^\/+/, "");
    if (tail && b.endsWith(`/${tail}`)) return b;
  }
  if (bare && b.endsWith(`/${bare}`)) return b;

  // "/api" on its own is not a version prefix, so it still gets the full path.
  const baseHasVersion = /\/(v\d+|compatible-mode\d*|openai)$/.test(b);
  return baseHasVersion ? `${b}/${bare}` : `${b}/${cleanPath}`;
}

const CC = ["/v1/chat/completions", "/chat/completions"];
const MSG = ["/v1/messages", "/messages"];

console.log("\n1. openai style");
const ccCases: [string, string][] = [
  ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/chat/completions"],
  ["https://openrouter.ai/api/v1/", "https://openrouter.ai/api/v1/chat/completions"],
  ["https://openrouter.ai/api", "https://openrouter.ai/api/v1/chat/completions"],
  ["https://openrouter.ai", "https://openrouter.ai/v1/chat/completions"],
  ["https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"],
  ["https://host.example:8080", "https://host.example:8080/v1/chat/completions"],
  ["http://127.0.0.1:4000/v1", "http://127.0.0.1:4000/v1/chat/completions"],
  ["http://127.0.0.1:1234", "http://127.0.0.1:1234/v1/chat/completions"],
];
for (const [base, want] of ccCases) {
  const got = resolve(base, "/v1/chat/completions", CC);
  check(`base ${base}`, got === want, got === want ? "" : `got ${got}, want ${want}`);
}

console.log("\n2. never doubles the version prefix");
for (const base of ["https://openrouter.ai/api/v1", "https://api.openai.com/v1"]) {
  const got = resolve(base, "/v1/chat/completions", CC);
  check(`${base} has no /v1/v1`, !got.includes("/v1/v1"), got);
}

console.log("\n3. anthropic style");
const msgCases: [string, string][] = [
  ["https://api.anthropic.com", "https://api.anthropic.com/v1/messages"],
  ["https://api.anthropic.com/v1", "https://api.anthropic.com/v1/messages"],
  ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/messages"],
];
for (const [base, want] of msgCases) {
  const got = resolve(base, "/v1/messages", MSG);
  check(`base ${base}`, got === want, got === want ? "" : `got ${got}, want ${want}`);
}

console.log("\n4. idempotent: resolving twice is stable");
{
  const once = resolve("https://openrouter.ai/api/v1", "/v1/chat/completions", CC);
  const twice = resolve(once, "/v1/chat/completions", CC);
  check("second pass is a no-op", once === twice, `${once} -> ${twice}`);
}

console.log("\n5. empty base is rejected");
let threw = false;
try {
  resolve("", "/v1/messages", MSG);
} catch {
  threw = true;
}
check("empty base throws", threw);

console.log(`\n${failures.length ? "FAILED" : "PASSED"}: ${failures.length} failure(s)`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);