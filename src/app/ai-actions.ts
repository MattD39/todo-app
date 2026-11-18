"use server";

import { getCurrentUser } from "@/lib/auth";
import { suggestSteps } from "@/lib/ai";
import { claudeErrorMessage, cleanTask } from "@/lib/ai-request";

// Server actions for the Claude features. Each Claude request costs money, so
// only a signed-in user may make one, and the input is checked first.
// ("Ask Claude" streams its answer, so it lives in src/app/api/ask/route.ts.)

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
