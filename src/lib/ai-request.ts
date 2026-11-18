import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { unstable_rethrow } from "next/navigation";
import { ClaudeError, type TaskForClaude } from "./ai";
import { MAX_CATEGORY, MAX_NOTES, MAX_STEPS, MAX_TITLE } from "./tasks";

// Shared checks for everything that sends a request to Claude from the browser
// (the server actions in src/app/ai-actions.ts and the /api/ask route).
// Anything typed in a browser can be faked, so it's all checked again here.

export const MAX_QUESTION = 500;

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
  if (error instanceof ClaudeError) return error.message;
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
