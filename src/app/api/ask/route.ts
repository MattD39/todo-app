import { getCurrentUser } from "@/lib/auth";
import { askAboutTask } from "@/lib/ai";
import { claudeErrorMessage, cleanQuestion, cleanTask } from "@/lib/ai-request";
import { nowIn } from "@/lib/dates";
import { getTimeZone } from "@/lib/timezone";

// POST /api/ask: the "Ask Claude" box in the task editor.
// Body: { task: {title, category, notes, steps, ...}, question: "..." }.
//
// This is a route handler rather than a server action because a server action
// sends back one finished answer, while this streams Claude's answer as plain
// text, piece by piece, so the words appear on screen as Claude writes them.
//
// Problems before the answer starts come back as { error } with an error
// status. If something breaks halfway, the stream just stops with an error and
// the browser says the answer was cut off.
export async function POST(request: Request) {
  try {
    await getCurrentUser(); // each question costs money: signed-in users only

    const body: unknown = await request.json().catch(() => null);
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const task = cleanTask(input.task);
    const question = cleanQuestion(input.question);
    if (!task.title) return errorResponse("Give the task a title first.", 400);
    if (!question) return errorResponse("Type a question first.", 400);

    // Read the clock only after the login check (Next.js requires that order).
    const { today } = nowIn(await getTimeZone());

    // Stops Claude when the browser goes away (Stop button, sheet closed).
    const stop = new AbortController();
    request.signal.addEventListener("abort", () => stop.abort());

    const pieces = askAboutTask(task, question, today, stop.signal);
    // Wait for the first piece here, so a problem at the start (Claude busy,
    // bad key) can still be sent back as a normal error message.
    const first = await pieces.next();

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (!first.done) controller.enqueue(encoder.encode(first.value));
        if (first.done) controller.close();
      },
      async pull(controller) {
        try {
          const next = await pieces.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (error) {
          if (!stop.signal.aborted) claudeErrorMessage(error); // logs unexpected problems
          controller.error(error);
        }
      },
      cancel() {
        stop.abort();
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (error) {
    // claudeErrorMessage re-throws the "go to /login" redirect so Next.js can send it.
    return errorResponse(claudeErrorMessage(error), 502);
  }
}

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
