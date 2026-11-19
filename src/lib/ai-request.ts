import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { unstable_rethrow } from "next/navigation";
import { ClaudeError, type ChangeReport, type ChatTurn, type TaskForClaude } from "./ai";
import { MAX_CHANGES_PER_MESSAGE } from "./chat-changes";
import { MAX_CATEGORY, MAX_NOTES, MAX_STEPS, MAX_TITLE } from "./tasks";
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
    // (A reply with no words still counts if it made changes or was stopped.)
    if (!role || (!body && changes.length === 0 && !stopped)) continue;
    // Two in a row from the same side (e.g. after a failed answer): keep the newer one.
    if (turns.at(-1)?.role === role) turns.pop();
    turns.push({ role, text: body, ...(changes.length ? { changes } : {}), ...(stopped ? { stopped } : {}) });
  }
  while (turns.length > MAX_CHAT_TURNS) turns.shift();
  while (turns[0]?.role === "assistant") turns.shift();
  return turns.at(-1)?.role === "user" ? turns : [];
}

// What the chat says happened to a reply's changes. Odd entries are dropped.
function cleanReports(input: unknown): ChangeReport[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_CHANGES_PER_MESSAGE).flatMap((item): ChangeReport[] => {
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
        if (!stop.signal.aborted) claudeErrorMessage(error); // logs unexpected problems
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

// The { error } reply for a failed Claude request, with a status that says
// what kind of problem it was. A limit gets 429 ("too many requests") and a
// Retry-After header saying how many seconds until it's allowed again.
export function claudeErrorResponse(error: unknown): Response {
  const message = claudeErrorMessage(error); // re-throws the "go to /login" redirect
  if (error instanceof LimitError) {
    return Response.json(
      { error: message },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(error.retryAfterSeconds) } },
    );
  }
  return errorResponse(message, 502);
}

// Fires when the browser goes away (Stop button, screen closed), so Claude
// stops writing (and costing money) straight away.
export function stopWhenBrowserLeaves(request: Request): AbortController {
  const stop = new AbortController();
  request.signal.addEventListener("abort", () => stop.abort());
  return stop;
}

export function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
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

// Turns any failure into a short message for the screen.
export function claudeErrorMessage(error: unknown): string {
  // An expired login "throws" a redirect to /login; let Next.js carry it out.
  unstable_rethrow(error);
  if (error instanceof ClaudeError || error instanceof LimitError) return error.message;
  // You pressed Stop (or closed the screen): not a problem, nothing to log.
  if (error instanceof Anthropic.APIUserAbortError) return "Stopped.";
  if (error instanceof Anthropic.RateLimitError) {
    return "Claude is busy or the usage limit was reached. Try again in a bit.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Couldn't reach Claude. Check your connection and try again.";
  }
  if (error instanceof Anthropic.APIError && error.status >= 500) {
    return "Claude is having trouble right now. Try again in a bit.";
  }
  // Wrong key, billing, a bug: details go to the server log, not the screen.
  console.error("Claude request failed", error);
  return "Something went wrong reaching Claude. Try again.";
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
