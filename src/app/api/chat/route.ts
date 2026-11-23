import { getSignedInUser } from "@/lib/auth";
import { chatAboutTasks, END_OF_TEXT } from "@/lib/ai";
import {
  claudeErrorResponse,
  signedOutResponse,
  cleanChat,
  errorResponse,
  readBody,
  stopWhenBrowserLeaves,
  streamTextResponse,
} from "@/lib/ai-request";
import type { ChatChange } from "@/lib/chat-changes";
import { addDays, nowIn } from "@/lib/dates";
import { cleanPhoto, PHOTO_ONLY_MESSAGE } from "@/lib/schedule-photo";
import { listHistory, listOpenTasks } from "@/lib/tasks";
import { getTimeZone } from "@/lib/timezone";
import { startClaudeUse } from "@/lib/usage";

// POST /api/chat: the Chat tab. Body: { messages: [{ role, text }, ...], photo? },
// the conversation so far, ending with your newest message, and optionally a
// photo for that message: { data: base64 } (Photo to schedule; see
// src/lib/schedule-photo.ts).
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
    // Each message costs money: signed-in users only. (The proxy turns most
    // signed-out requests away already; this catches a login that just expired.)
    if (!(await getSignedInUser())) return signedOutResponse();

    const body = await readBody(request);
    // Photo to schedule: an optional photo with the newest message. Used for
    // this one request only: never saved, never logged.
    const photo = cleanPhoto(body.photo);
    if (typeof photo === "string") return errorResponse(photo, 400);
    const turns = cleanChat(photo ? withPhotoOnlyText(body.messages) : body.messages);
    if (turns.length === 0) return errorResponse("Type a message first.", 400);

    // Read the clock only after the login check (Next.js requires that order).
    const timeZone = await getTimeZone();
    const now = nowIn(timeZone);
    const [open, history] = await Promise.all([listOpenTasks(), listHistory(addDays(now.today, -6), now.today)]);

    // Counted last, just before Claude is asked, so a problem loading your
    // tasks doesn't use up one of your messages. Throws if a limit is reached.
    // A photo message has its own, smaller limit (and still counts as a chat message).
    const use = await startClaudeUse(photo ? "chat_photo" : "chat");
    const stop = stopWhenBrowserLeaves(request);
    const queue: ChatChange[] = [];
    const reply = chatAboutTasks(turns, { open, history, now, timeZone }, stop.signal, queue, use.meter, photo);
    return await streamTextResponse(withChanges(reply, queue), stop, use);
  } catch (error) {
    // claudeErrorResponse re-throws the "go to /login" redirect so Next.js can send it.
    return claudeErrorResponse(error);
  }
}

// A photo can be sent with no words: the newest message then gets a short
// stand-in text, so it isn't dropped as empty.
function withPhotoOnlyText(messages: unknown): unknown {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const last = messages.at(-1) as { role?: unknown; text?: unknown } | null;
  if (last?.role !== "user" || (typeof last.text === "string" && last.text.trim())) return messages;
  return [...messages.slice(0, -1), { ...last, text: PHOTO_ONLY_MESSAGE }];
}

// Claude's reply, then (once it's finished) the changes it queued.
async function* withChanges(reply: AsyncGenerator<string>, queue: ChatChange[]): AsyncGenerator<string> {
  yield* reply;
  if (queue.length > 0) yield END_OF_TEXT + JSON.stringify({ changes: queue });
}
