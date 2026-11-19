"use server";

import { getSignedInUser } from "@/lib/auth";
import { suggestSteps } from "@/lib/ai";
import { claudeProblem, cleanTask } from "@/lib/ai-request";
import { SIGNED_OUT_MESSAGE, type ProblemCode } from "@/lib/problems";
import { startClaudeUse } from "@/lib/usage";

// Server actions for the Claude features. Each Claude request costs money, so
// only a signed-in user may make one, within their limits (src/lib/usage.ts),
// and the input is checked first.
// ("Ask Claude" streams its answer, so it lives in src/app/api/ask/route.ts.)

// leftToday: how many step suggestions are left today, after this one.
// code: what kind of problem it was, when there is one (see problems.ts).
export type SuggestStepsResult = { error: string | null; code?: ProblemCode; steps?: string[]; leftToday?: number };

// Asks Claude for steps for the task as it is in the editor right now.
// Only suggests: the browser then adds them like normal steps.
export async function suggestTaskSteps(input: unknown): Promise<SuggestStepsResult> {
  try {
    // Signed out: say so, rather than jumping to the login page and losing
    // what's typed in the editor.
    if (!(await getSignedInUser())) return { error: SIGNED_OUT_MESSAGE, code: "signed_out" };
    const task = cleanTask(input);
    if (!task.title) return { error: "Give the task a title first.", code: "bad_input" };
    const use = await startClaudeUse("suggest_steps"); // throws if a limit is reached
    try {
      return { error: null, steps: await suggestSteps(task, use.meter), leftToday: use.leftToday };
    } finally {
      await use.finish();
    }
  } catch (error) {
    const { message, code } = claudeProblem(error);
    return { error: message, code };
  }
}
