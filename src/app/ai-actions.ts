"use server";

import Anthropic from "@anthropic-ai/sdk";
import { unstable_rethrow } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { ClaudeError, suggestSteps, type TaskForClaude } from "@/lib/ai";
import { MAX_CATEGORY, MAX_NOTES, MAX_STEPS, MAX_TITLE } from "@/lib/tasks";

// Server actions for the Claude features. Each Claude request costs money, so
// only a signed-in user may make one, and the input is checked first.

export type SuggestStepsResult = { error: string | null; steps?: string[] };

// Asks Claude for steps for the task as it is in the editor right now.
// Only suggests: the browser then adds them like normal steps.
export async function suggestTaskSteps(input: unknown): Promise<SuggestStepsResult> {
  try {
    await getCurrentUser(); // signed-out visitors are sent to /login
    const task = cleanTask(input);
    if (!task.title) return { error: "Give the task a title first." };
    return { error: null, steps: await suggestSteps(task) };
  } catch (error) {
    return { error: claudeErrorMessage(error) };
  }
}

// The editor's fields, checked and trimmed. Anything odd becomes empty.
function cleanTask(input: unknown): TaskForClaude {
  const value = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const steps = Array.isArray(value.steps) ? value.steps : [];
  return {
    title: text(value.title, MAX_TITLE),
    category: text(value.category, MAX_CATEGORY),
    notes: text(value.notes, MAX_NOTES),
    steps: steps
      .slice(0, MAX_STEPS)
      .map((s) => text(s, MAX_TITLE))
      .filter(Boolean),
  };
}

// Turns any failure into a short message for the screen.
function claudeErrorMessage(error: unknown): string {
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
