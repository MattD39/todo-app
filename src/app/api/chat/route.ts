import { getCurrentUser } from "@/lib/auth";
import { chatAboutTasks, END_OF_TEXT } from "@/lib/ai";
import {
  claudeErrorMessage,
  cleanChat,
  errorResponse,
  readBody,
  stopWhenBrowserLeaves,
  streamTextResponse,
} from "@/lib/ai-request";
import type { ChatChange } from "@/lib/chat-changes";
import { addDays, nowIn } from "@/lib/dates";
import { listHistory, listOpenTasks } from "@/lib/tasks";
import { getTimeZone } from "@/lib/timezone";

// POST /api/chat: the Chat tab. Body: { messages: [{ role, text }, ...] },
// the conversation so far, ending with your newest message.
//
// The browser sends only the conversation, never tasks: the server loads your
// tasks itself, through src/lib/tasks.ts, so the database's own rules decide
// what Claude gets to see.
//
// Streams the reply like /api/ask does. If Claude asked for changes, the end
// of the stream is END_OF_TEXT followed by JSON: { changes: [...] }. Nothing
// is saved here; the chat saves them with applyChatChanges
// (src/app/chat-actions.ts). Saving needs your login, which can only be
// checked while a request is being handled, not from a stream that's still
// going after the route has answered.
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
    const queue: ChatChange[] = [];
    const reply = chatAboutTasks(turns, { open, history, now, timeZone }, stop.signal, queue);
    return await streamTextResponse(withChanges(reply, queue), stop);
  } catch (error) {
    // claudeErrorMessage re-throws the "go to /login" redirect so Next.js can send it.
    return errorResponse(claudeErrorMessage(error), 502);
  }
}

// Claude's reply, then (once it's finished) the changes it queued.
async function* withChanges(reply: AsyncGenerator<string>, queue: ChatChange[]): AsyncGenerator<string> {
  yield* reply;
  if (queue.length > 0) yield END_OF_TEXT + JSON.stringify({ changes: queue });
}
