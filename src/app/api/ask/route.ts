import { getCurrentUser } from "@/lib/auth";
import { askAboutTask } from "@/lib/ai";
import {
  claudeErrorMessage,
  cleanQuestion,
  cleanTask,
  errorResponse,
  readBody,
  stopWhenBrowserLeaves,
  streamTextResponse,
} from "@/lib/ai-request";
import { nowIn } from "@/lib/dates";
import { getTimeZone } from "@/lib/timezone";

// POST /api/ask: the "Ask Claude" box in the task editor.
// Body: { task: {title, category, notes, steps, ...}, question: "..." }.
//
// This is a route handler rather than a server action because a server action
// sends back one finished answer, while this streams Claude's answer as plain
// text, piece by piece, so the words appear on screen as Claude writes them.
// Problems before the answer starts come back as { error } with an error status.
export async function POST(request: Request) {
  try {
    await getCurrentUser(); // each question costs money: signed-in users only

    const input = await readBody(request);
    const task = cleanTask(input.task);
    const question = cleanQuestion(input.question);
    if (!task.title) return errorResponse("Give the task a title first.", 400);
    if (!question) return errorResponse("Type a question first.", 400);

    // Read the clock only after the login check (Next.js requires that order).
    const { today } = nowIn(await getTimeZone());

    const stop = stopWhenBrowserLeaves(request);
    return await streamTextResponse(askAboutTask(task, question, today, stop.signal), stop);
  } catch (error) {
    // claudeErrorMessage re-throws the "go to /login" redirect so Next.js can send it.
    return errorResponse(claudeErrorMessage(error), 502);
  }
}
