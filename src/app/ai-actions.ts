"use server";

import { getCurrentUser } from "@/lib/auth";
import { suggestSteps } from "@/lib/ai";
import { claudeErrorMessage, cleanTask } from "@/lib/ai-request";
import { startClaudeUse } from "@/lib/usage";

// Server actions for the Claude features. Each Claude request costs money, so
// only a signed-in user may make one, within their limits (src/lib/usage.ts),
// and the input is checked first.
// ("Ask Claude" streams its answer, so it lives in src/app/api/ask/route.ts.)

// leftToday: how many step suggestions are left today, after this one.
export type SuggestStepsResult = { error: string | null; steps?: string[]; leftToday?: number };

// Asks Claude for steps for the task as it is in the editor right now.
// Only suggests: the browser then adds them like normal steps.
export async function suggestTaskSteps(input: unknown): Promise<SuggestStepsResult> {
  try {
    await getCurrentUser(); // signed-out visitors are sent to /login
    const task = cleanTask(input);
    if (!task.title) return { error: "Give the task a title first." };
    const use = await startClaudeUse("suggest_steps"); // throws if a limit is reached
    try {
      return { error: null, steps: await suggestSteps(task, use.meter), leftToday: use.leftToday };
    } finally {
      await use.finish();
    }
  } catch (error) {
    return { error: claudeErrorMessage(error) };
  }
}
