//
// Checks each kind of Claude problem gets the right message for the screen.
//
// Run with: npm run check:errors
//
// Free: no Claude calls, no database. It builds the same error objects the
// Anthropic SDK throws (busy, overloaded, failing, spend cap, no credit, bad
// key, no connection, Stop) plus the app's own (limits, no useful answer),
// and checks claudeProblem() in src/lib/ai-request.ts sorts each one into the
// right code, status and message. Exits with an error if any check fails.

import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createJiti } from "jiti";

// Load the app's server code (which normally only runs inside Next.js).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "server-only": path.join(root, "scripts/server-only-stub.cjs"),
    "@/": path.join(root, "src") + path.sep,
  },
});
const { claudeProblem } = await jiti.import<typeof import("../src/lib/ai-request.ts")>(
  path.join(root, "src/lib/ai-request.ts"),
);
const { LimitError } = await jiti.import<typeof import("../src/lib/usage.ts")>(path.join(root, "src/lib/usage.ts"));
const { ClaudeError } = await jiti.import<typeof import("../src/lib/ai.ts")>(path.join(root, "src/lib/ai.ts"));
// The app must use the same SDK copy, or "instanceof" checks would fail.
const { default: AppAnthropic } = await jiti.import<typeof import("@anthropic-ai/sdk")>("@anthropic-ai/sdk");

// The problems are logged on purpose (so the app owner sees them); keep this
// script's output to the results.
console.warn = () => {};
console.error = () => {};

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}\n`);
}

// An error exactly as the SDK builds it from an API reply.
function apiError(status: number, type: string, errorCode?: string) {
  const body = {
    type: "error",
    error: { type, message: "made-up message", ...(errorCode ? { details: { error_code: errorCode } } : {}) },
  };
  return AppAnthropic.APIError.generate(status, body, undefined, new Headers());
}

const cases: { name: string; error: unknown; code: string; status: number; says: RegExp }[] = [
  { name: "Claude overloaded (529)", error: apiError(529, "overloaded_error"), code: "busy", status: 503, says: /very busy/ },
  { name: "the app's account hit Claude's rate limit (429)", error: apiError(429, "rate_limit_error"), code: "busy", status: 503, says: /very busy/ },
  {
    name: "monthly spend cap reached (429 enforced_spend_limit_reached)",
    error: apiError(429, "rate_limit_error", "enforced_spend_limit_reached"),
    code: "budget",
    status: 503,
    says: /monthly Claude budget.*rest of the app still works/,
  },
  { name: "billing problem, e.g. no credit (402)", error: apiError(402, "billing_error"), code: "budget", status: 503, says: /budget/ },
  { name: "Claude's servers failing (500)", error: apiError(500, "api_error"), code: "claude_down", status: 502, says: /having problems/ },
  {
    name: "couldn't connect to Claude",
    error: new AppAnthropic.APIConnectionError({ message: "fetch failed" }),
    code: "unreachable",
    status: 502,
    says: /Couldn't reach Claude/,
  },
  { name: "connection timed out", error: new AppAnthropic.APIConnectionTimeoutError(), code: "unreachable", status: 502, says: /Couldn't reach/ },
  { name: "bad API key (401)", error: apiError(401, "authentication_error"), code: "unexpected", status: 500, says: /let the app owner know/ },
  { name: "a bug: bad request (400)", error: apiError(400, "invalid_request_error"), code: "unexpected", status: 500, says: /let the app owner know/ },
  { name: "any other crash", error: new TypeError("oops"), code: "unexpected", status: 500, says: /let the app owner know/ },
  { name: "you pressed Stop", error: new AppAnthropic.APIUserAbortError(), code: "stopped", status: 400, says: /Stopped/ },
  {
    name: "one of your limits (the app's own)",
    error: new LimitError("You've used today's 40 chat messages. More at midnight.", 3600),
    code: "limit",
    status: 429,
    says: /40 chat messages/,
  },
  {
    name: "Claude gave no useful answer",
    error: new ClaudeError("Claude didn't have an answer. Try asking another way."),
    code: "no_answer",
    status: 502,
    says: /didn't have an answer/,
  },
];

for (const c of cases) {
  const p = claudeProblem(c.error);
  check(
    `${c.name} → ${c.code}`,
    p.code === c.code && p.status === c.status && c.says.test(p.message),
    `got ${p.code} ${p.status}: ${p.message}`,
  );
}

// The script's own SDK copy should be the app's (otherwise the cases above prove little).
check("the checks use the same Anthropic SDK as the app", AppAnthropic === Anthropic || AppAnthropic.APIError === Anthropic.APIError);

process.stdout.write(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
