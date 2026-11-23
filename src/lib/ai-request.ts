import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { unstable_rethrow } from "next/navigation";
import { ClaudeError, type ChangeReport, type ChatTurn, type TaskForClaude } from "./ai";
import { MAX_SAVED_PER_MESSAGE } from "./chat-changes";
import { MAX_CATEGORY, MAX_NOTES, MAX_STEPS, MAX_TITLE } from "./tasks";
import { SIGNED_OUT_MESSAGE, type ProblemCode } from "./problems";
import { LimitError, type ClaudeUse } from "./usage";

// Shared checks for everything that sends a request to Claude from the browser
// (the server actions in src/app/ai-actions.ts and the /api/ask and /api/chat
// routes). Anything typed in a browser can be faked, so it's all checked again here.

export const MAX_QUESTION = 500;

// ─── The Chat tab ────────────────────────────────────────────────────────────

export const MAX_CHAT_MESSAGE = 1000;
const MAX_CHAT_REPLY = 8000; // Claude's earlier replies, as sent back by the browser
const MAX_CHAT_TURNS = 20; // only the most recent messages go to Claude (keeps the cost down)

// The conversation the browser sent: checked, trimmed, cut to the last
// MAX_CHAT_TURNS messages. Always starts and ends with one of your messages,
// with you and Claude taking turns (an empty or broken list comes back empty).
export function cleanChat(input: unknown): ChatTurn[] {
  if (!Array.isArray(input)) return [];
  const turns: ChatTurn[] = [];
  for (const item of input.slice(-MAX_CHAT_TURNS * 2)) {
    const value = asRecord(item);
    const role = value.role === "user" || value.role === "assistant" ? value.role : null;
    const body = role ? text(value.text, role === "user" ? MAX_CHAT_MESSAGE : MAX_CHAT_REPLY) : "";
    const changes = role === "assistant" ? cleanReports(value.changes) : [];
    const stopped = role === "assistant" && value.stopped === true;
    // Your message had a photo attached (the photo itself isn't sent again).
    const hadPhoto = role === "user" && value.hadPhoto === true;
    // (A reply with no words still counts if it made changes or was stopped.)
    if (!role || (!body && changes.length === 0 && !stopped)) continue;
    // Two in a row from the same side (e.g. after a failed answer): keep the newer one.
    if (turns.at(-1)?.role === role) turns.pop();
    turns.push({
      role,
      text: body,
      ...(changes.length ? { changes } : {}),
      ...(stopped ? { stopped } : {}),
      ...(hadPhoto ? { hadPhoto } : {}),
    });
  }
  while (turns.length > MAX_CHAT_TURNS) turns.shift();
  while (turns[0]?.role === "assistant") turns.shift();
  return turns.at(-1)?.role === "user" ? turns : [];
}

// What the chat says happened to a reply's changes. Odd entries are dropped.
function cleanReports(input: unknown): ChangeReport[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_SAVED_PER_MESSAGE).flatMap((item): ChangeReport[] => {
    const value = asRecord(item);
    const summary = text(value.summary, 300);
    const status = oneOf(value.status, ["saved", "undone", "failed", "unknown"]) as ChangeReport["status"] | "";
    if (!summary || !status) return [];
    const error = text(value.error, 200);
    return [{ summary, status, ...(error ? { error } : {}) }];
  });
}

// ─── Streaming replies (shared by /api/ask and /api/chat) ────────────────────

// Sends Claude's answer to the browser as plain text, piece by piece.
// Waits for the first piece first, so a problem at the start (Claude busy, bad
// key) still comes back as a normal { error } message instead of a broken stream.
// If something breaks halfway, the stream just stops with an error and the
// browser says the answer was cut off.
//
// `use` is the counted use of Claude (from startClaudeUse): its cost is saved
// when the answer ends, however it ends, and the browser is told how many uses
// are left today (the X-Left-Today header).
export async function streamTextResponse(
  answer: AsyncGenerator<string>,
  stop: AbortController,
  use: ClaudeUse,
): Promise<Response> {
  const pieces = savingCost(answer, use);
  const first = await pieces.next();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(encoder.encode(first.value));
    },
    async pull(controller) {
      try {
        const next = await pieces.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        if (!stop.signal.aborted) claudeProblem(error); // logs problems the app owner should know about
        controller.error(error);
      }
    },
    cancel() {
      stop.abort();
      // Also close the answer if it's paused between pieces (nobody will ask
      // for the next one now), so its cost still gets saved.
      void pieces.return(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Left-Today": String(use.leftToday),
    },
  });
}

// The answer, unchanged, then saves what it cost once it ends: finished,
// failed or stopped.
async function* savingCost(answer: AsyncGenerator<string>, use: ClaudeUse): AsyncGenerator<string> {
  try {
    yield* answer;
  } finally {
    await use.finish();
  }
}

// The { error, code } reply for a failed Claude request, with a status that
// says what kind of problem it was. A limit gets 429 ("too many requests") and
// a Retry-After header saying how many seconds until it's allowed again.
export function claudeErrorResponse(error: unknown): Response {
  const { message, code, status } = claudeProblem(error); // re-throws the "go to /login" redirect
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (error instanceof LimitError) headers["Retry-After"] = String(error.retryAfterSeconds);
  return Response.json({ error: message, code }, { status, headers });
}

// Fires when the browser goes away (Stop button, screen closed), so Claude
// stops writing (and costing money) straight away.
export function stopWhenBrowserLeaves(request: Request): AbortController {
  const stop = new AbortController();
  request.signal.addEventListener("abort", () => stop.abort());
  return stop;
}

// A request that can't be answered as it is (e.g. no title): 400 by default.
export function errorResponse(message: string, status = 400, code: ProblemCode = "bad_input"): Response {
  return Response.json({ error: message, code }, { status, headers: { "Cache-Control": "no-store" } });
}

// The request body as an object (anything else becomes {}).
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  return asRecord(await request.json().catch(() => null));
}

// The editor's fields, checked and trimmed. Anything odd becomes empty.
export function cleanTask(input: unknown): TaskForClaude {
  const value = asRecord(input);
  const steps = Array.isArray(value.steps) ? value.steps : [];
  return {
    title: text(value.title, MAX_TITLE),
    category: text(value.category, MAX_CATEGORY),
    notes: text(value.notes, MAX_NOTES),
    steps: steps
      .slice(0, MAX_STEPS)
      .map((s) => text(s, MAX_TITLE))
      .filter(Boolean),
    // Short fields shown to Claude as extra context. Odd values are dropped.
    priority: oneOf(value.priority, ["low", "medium", "high"]),
    dueDate: matches(value.dueDate, /^\d{4}-\d{2}-\d{2}$/),
    dueTime: matches(value.dueTime, /^\d{2}:\d{2}$/),
    repeat: oneOf(value.repeat, ["daily", "weekly", "monthly"]),
  };
}

// The question typed in the "Ask Claude" box, trimmed to a sensible length.
export function cleanQuestion(input: unknown): string {
  return text(input, MAX_QUESTION);
}

// What went wrong, as a message for the screen, a code for the browser (see
// problems.ts) and an HTTP status for the /api routes.
export type ClaudeProblem = { message: string; code: ProblemCode; status: number };

// Turns any failure into a ClaudeProblem. Problems the app owner should know
// about (budget used up, Claude busy or failing, a bug) go to the server log.
export function claudeProblem(error: unknown): ClaudeProblem {
  // An expired login "throws" a redirect to /login; let Next.js carry it out.
  unstable_rethrow(error);
  if (error instanceof LimitError) return { message: error.message, code: "limit", status: 429 };
  if (error instanceof ClaudeError) return { message: error.message, code: "no_answer", status: 502 };
  // You pressed Stop (or closed the screen): not a problem, nothing to log.
  if (error instanceof Anthropic.APIUserAbortError) return { message: "Stopped.", code: "stopped", status: 400 };
  // (Checked before APIError: in this SDK a connection error is a kind of APIError.)
  if (error instanceof Anthropic.APIConnectionError) {
    console.warn("Couldn't connect to Claude", error.message);
    return { message: "Couldn't reach Claude just now. Try again in a moment.", code: "unreachable", status: 502 };
  }
  if (error instanceof Anthropic.APIError) {
    // The account's monthly spend cap (a 429 that retrying won't fix), or a
    // billing problem such as no credit left.
    if (error.errorCode === "enforced_spend_limit_reached" || error.type === "billing_error") {
      console.error("Claude budget used up", error.status, error.type, error.errorCode);
      return {
        message: "This app's monthly Claude budget is used up. The rest of the app still works.",
        code: "budget",
        status: 503,
      };
    }
    // Overloaded (529), or the app's account hit Claude's own rate limit.
    // (The SDK has already tried again twice by now.)
    if (error instanceof Anthropic.RateLimitError || error.type === "overloaded_error" || error.status === 529) {
      console.warn("Claude is busy", error.status, error.type);
      return { message: "Claude is very busy right now. Try again in a minute.", code: "busy", status: 503 };
    }
    if (error.status !== undefined && error.status >= 500) {
      console.warn("Claude is having problems", error.status, error.type);
      return {
        message: "Claude is having problems right now. Try again in a few minutes.",
        code: "claude_down",
        status: 502,
      };
    }
  }
  // Wrong key, a bad request, a bug: details go to the server log, not the screen.
  console.error("Claude request failed", error);
  return {
    message: "Something went wrong with Claude. If it keeps happening, let the app owner know.",
    code: "unexpected",
    status: 500,
  };
}

// Just the message (for the server actions).
export function claudeErrorMessage(error: unknown): string {
  return claudeProblem(error).message;
}

// The { error, code } reply for a signed-out visitor (401). The browser shows
// the message and keeps whatever was typed.
export function signedOutResponse(): Response {
  return Response.json(
    { error: SIGNED_OUT_MESSAGE, code: "signed_out" satisfies ProblemCode },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

function asRecord(input: unknown): Record<string, unknown> {
  return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function oneOf(v: unknown, allowed: string[]): string {
  return typeof v === "string" && allowed.includes(v) ? v : "";
}

function matches(v: unknown, pattern: RegExp): string {
  return typeof v === "string" && pattern.test(v) ? v : "";
}
