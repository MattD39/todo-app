import { getSignedInUser } from "@/lib/auth";
import { askAboutTask } from "@/lib/ai";
import {
  claudeErrorResponse,
  signedOutResponse,
  cleanQuestion,
  cleanTask,
  errorResponse,
  readBody,
  stopWhenBrowserLeaves,
  streamTextResponse,
} from "@/lib/ai-request";
import { nowIn } from "@/lib/dates";
import { getTimeZone } from "@/lib/timezone";
import { startClaudeUse } from "@/lib/usage";

// POST /api/ask: the "Ask Claude" box in the task editor.
// Body: { task: {title, category, notes, steps, ...}, question: "..." }.
//
// This is a route handler rather than a server action because a server action
// sends back one finished answer, while this streams Claude's answer as plain
// text, piece by piece, so the words appear on screen as Claude writes them.
// Problems before the answer starts come back as { error } with an error status
// (429 when one of your limits is reached: see src/lib/usage.ts).
export async function POST(request: Request) {
  try {
    // Each question costs money: signed-in users only. (The proxy turns most
    // signed-out requests away already; this catches a login that just expired.)
    if (!(await getSignedInUser())) return signedOutResponse();

    const input = await readBody(request);
    const task = cleanTask(input.task);
    const question = cleanQuestion(input.question);
    if (!task.title) return errorResponse("Give the task a title first.", 400);
    if (!question) return errorResponse("Type a question first.", 400);

    // Read the clock only after the login check (Next.js requires that order).
    const { today } = nowIn(await getTimeZone());

    const use = await startClaudeUse("ask"); // throws if a limit is reached
    const stop = stopWhenBrowserLeaves(request);
    return await streamTextResponse(askAboutTask(task, question, today, stop.signal, use.meter), stop, use);
  } catch (error) {
    // claudeErrorResponse re-throws the "go to /login" redirect so Next.js can send it.
    return claudeErrorResponse(error);
  }
}
