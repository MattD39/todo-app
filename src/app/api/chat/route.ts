import { getCurrentUser } from "@/lib/auth";
import { chatAboutTasks } from "@/lib/ai";
import {
  claudeErrorMessage,
  cleanChat,
  errorResponse,
  readBody,
  stopWhenBrowserLeaves,
  streamTextResponse,
} from "@/lib/ai-request";
import { addDays, nowIn } from "@/lib/dates";
import { listHistory, listOpenTasks } from "@/lib/tasks";
import { getTimeZone } from "@/lib/timezone";

// POST /api/chat: the Chat tab. Body: { messages: [{ role, text }, ...] },
// the conversation so far, ending with your newest message.
//
// The browser sends only the conversation, never tasks: the server loads your
// tasks itself, through src/lib/tasks.ts, so the database's own rules decide
// what Claude gets to see. Claude can only read them here; nothing is changed.
// Streams the reply like /api/ask does.
export async function POST(request: Request) {
  try {
    await getCurrentUser(); // each message costs money: signed-in users only

    const turns = cleanChat((await readBody(request)).messages);
    if (turns.length === 0) return errorResponse("Type a message first.", 400);

    // Read the clock only after the login check (Next.js requires that order).
    const timeZone = await getTimeZone();
    const now = nowIn(timeZone);
    const [open, history] = await Promise.all([listOpenTasks(), listHistory(addDays(now.today, -6), now.today)]);

    const stop = stopWhenBrowserLeaves(request);
    const pieces = chatAboutTasks(turns, { open, history, now, timeZone }, stop.signal);
    return await streamTextResponse(pieces, stop);
  } catch (error) {
    // claudeErrorMessage re-throws the "go to /login" redirect so Next.js can send it.
    return errorResponse(claudeErrorMessage(error), 502);
  }
}
