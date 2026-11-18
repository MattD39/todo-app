import "server-only";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type Anthropic from "@anthropic-ai/sdk";
import { MODEL, USER_DATA_RULE, asUserData, getClaude } from "./claude";
import { addDays, dayOf, formatDay, formatTime, isOverdue, relDay, type Now } from "./dates";
import { MAX_TITLE, type HistoryDTO, type TaskDTO } from "./tasks";

// The app's Claude features. Each one builds a prompt from the task, asks
// Claude, and checks the answer before handing it back. Nothing here reads or
// changes the database: saving stays in src/lib/tasks.ts.

// The task as it is in the editor right now (maybe not saved yet).
export type TaskForClaude = {
  title: string;
  category: string;
  notes: string;
  steps: string[]; // steps already on the list
  // Optional extra context ("" or missing = not set).
  priority?: string;
  dueDate?: string; // "YYYY-MM-DD"
  dueTime?: string; // "HH:MM"
  repeat?: string;
};

// Thrown when Claude couldn't give a usable answer; the message is safe to show.
export class ClaudeError extends Error {}

const MAX_SUGGESTED = 8;

const SUGGEST_STEPS_PROMPT =
  "You help someone break a task from their personal to-do list into steps they can tick off. " +
  "Suggest 3 to 6 short, concrete steps in the order they'd do them. Each step starts with a verb and is " +
  "under 60 characters. Don't repeat steps that are already on the list. If the task is too vague to " +
  "break down, suggest sensible first steps anyway.\n\n" +
  USER_DATA_RULE;

// Claude's answer must match this shape: { "steps": ["Find the form", ...] }.
const stepsFormat = jsonSchemaOutputFormat({
  type: "object",
  properties: { steps: { type: "array", items: { type: "string" } } },
  required: ["steps"],
  additionalProperties: false,
});

// Returns new step titles for the task. Doesn't save them.
export async function suggestSteps(task: TaskForClaude): Promise<string[]> {
  const response = await getClaude().messages.parse({
    model: MODEL,
    max_tokens: 4000,
    // A small, simple job: low effort keeps it quick and cheap.
    output_config: { effort: "low", format: stepsFormat },
    system: SUGGEST_STEPS_PROMPT,
    messages: [{ role: "user", content: `${asUserData(describe(task))}\n\nSuggest steps for this task.` }],
  });

  if (response.stop_reason === "refusal") throw new ClaudeError("Claude couldn't help with this task.");
  const already = new Set(task.steps.map((s) => s.trim().toLowerCase()));
  const steps = (response.parsed_output?.steps ?? [])
    .map((s) => s.trim().slice(0, MAX_TITLE))
    .filter((s) => s && !already.has(s.toLowerCase()))
    .slice(0, MAX_SUGGESTED);
  if (steps.length === 0) {
    throw new ClaudeError("Claude didn't suggest any new steps. Try adding a bit more detail in Notes.");
  }
  return steps;
}

const ASK_PROMPT =
  "You answer questions about one task from someone's personal to-do list. Be practical and brief: " +
  "usually 2 to 5 sentences, or a short list when that's clearer. Write plain text with no Markdown " +
  '(no headings, bold, tables or code blocks); a list is lines starting with "- ". ' +
  "You can only answer. You can't change the task, add steps, set reminders or look anything up, so never " +
  "say you did or will. If the question has nothing to do with the task, answer it briefly anyway.\n\n" +
  USER_DATA_RULE;

// Answers a question about the task, a piece at a time as Claude writes it.
// `today` ("YYYY-MM-DD", the user's time zone) lets Claude talk about due dates.
// Aborting `signal` stops Claude straight away (so it stops costing money too).
export async function* askAboutTask(
  task: TaskForClaude,
  question: string,
  today: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  yield* streamAnswer(
    ASK_PROMPT,
    [
      {
        role: "user",
        // The question is the user's own request, so it sits outside <user_data>.
        content: `Today is ${today}.\n\n${asUserData(describe(task))}\n\nMy question about this task: ${question}`,
      },
    ],
    signal,
  );
}

// One message in the Chat tab's conversation.
export type ChatTurn = { role: "user" | "assistant"; text: string };

// What Claude can see in the Chat tab: a snapshot of the task list, loaded by
// the server (src/lib/tasks.ts) for each message.
export type ChatSnapshot = {
  open: TaskDTO[];
  history: HistoryDTO; // what was finished in the last 7 days
  now: Now;
  timeZone: string;
};

const CHAT_PROMPT =
  "You are the assistant inside someone's personal to-do app, chatting with them about their tasks. " +
  "Their newest message comes with a snapshot of their task list as it is right now: their open tasks and " +
  "what they finished in the last 7 days. Use it to answer things like what's due, what to do first, " +
  "what's overdue or how their week went. Earlier messages may talk about tasks that have changed since; " +
  "the snapshot is what's true now.\n\n" +
  "Be practical, friendly and brief: usually 1 to 5 sentences, or a short list when that's clearer. " +
  "Write plain text with no Markdown (no headings, bold, tables or code blocks); a list is lines starting " +
  'with "- ". Call tasks by their titles. For dates, say "today", "tomorrow" or the weekday when that\'s ' +
  "clearer than a date.\n\n" +
  "In this chat you can only read the task list. You can't add, change, tick off or delete tasks, set " +
  "reminders or look anything up, so never say you did or will. If they ask for a change, say they can " +
  "make it themselves by tapping the task on another tab (or Add task on the Today tab to add one). If something isn't in the snapshot " +
  "(like tasks finished more than 7 days ago), say you can't see it rather than guessing. If a message has " +
  "nothing to do with their tasks, answer it briefly anyway.\n\n" +
  USER_DATA_RULE;

// Replies in the Chat tab, a piece at a time. `turns` is the conversation so
// far (from cleanChat: starts and ends with the user). The task snapshot goes
// with the newest message only, so Claude always reads the current list.
export async function* chatAboutTasks(
  turns: ChatTurn[],
  snapshot: ChatSnapshot,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const { now } = snapshot;
  const header = `Right now it's ${formatDay(now.today, { withYear: true })} (${now.today}), ${formatTime(now.time)}.`;
  const messages: Anthropic.MessageParam[] = turns.map((turn, i) =>
    i === turns.length - 1
      ? // The message is the user's own words, so it sits outside <user_data>.
        { role: "user", content: `${header}\n\n${asUserData(describeTaskList(snapshot))}\n\nMy message: ${turn.text}` }
      : { role: turn.role, content: turn.text },
  );
  yield* streamAnswer(CHAT_PROMPT, messages, signal);
}

// Asks Claude and hands back its answer a piece at a time as it's written.
// Aborting `signal` stops Claude straight away (so it stops costing money too).
async function* streamAnswer(
  system: string,
  messages: Anthropic.MessageParam[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  const stream = getClaude().messages.stream(
    {
      model: MODEL,
      max_tokens: 4000,
      // Short answers to everyday questions: low effort keeps them quick and cheap.
      output_config: { effort: "low" },
      system,
      messages,
    },
    { signal },
  );

  let wroteSomething = false;
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
      wroteSomething = true;
      yield event.delta.text;
    }
  }

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal" && !wroteSomething) {
    throw new ClaudeError("Claude couldn't help with that question.");
  }
  if (message.stop_reason === "max_tokens") yield "…";
  if (!wroteSomething && message.stop_reason !== "max_tokens") {
    throw new ClaudeError("Claude didn't have an answer. Try asking another way.");
  }
}

// Limits that keep a chat message's snapshot (and its cost) a sensible size.
const CHAT_MAX_OPEN = 150;
const CHAT_MAX_DONE = 60;
const CHAT_MAX_NOTES = 300; // characters of notes per task
const CHAT_MAX_STEPS = 15; // steps listed per task

// The task list as plain text for the Chat tab. Goes inside asUserData().
function describeTaskList({ open, history, now, timeZone }: ChatSnapshot): string {
  const lines = open.slice(0, CHAT_MAX_OPEN).map((task) => `- ${describeOpenTask(task, now)}`);
  const openPart =
    open.length === 0
      ? "OPEN TASKS: none."
      : `OPEN TASKS (${open.length}, soonest first${open.length > CHAT_MAX_OPEN ? `; only the first ${CHAT_MAX_OPEN} shown` : ""}):\n${lines.join("\n")}`;

  // Finished in the last 7 days: one-off tasks, and each tick of a repeating one.
  const weekAgo = addDays(now.today, -6);
  const finished = [
    ...history.done
      .filter((t) => t.doneAt)
      .map((t) => ({ day: dayOf(t.doneAt!, timeZone), task: t, repeating: false })),
    ...history.ticks.map((t) => ({ day: t.completedOn, task: t as TaskDTO, repeating: true })),
  ]
    .filter((f) => f.day >= weekAgo && f.day <= now.today)
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, CHAT_MAX_DONE)
    .map(({ day, task, repeating }) => {
      const parts = [task.title, `finished ${relDay(day, now.today)} (${day})`];
      if (repeating) parts.push(`one round of a task that repeats ${task.repeat ?? ""}`.trim());
      if (task.category) parts.push(`category: ${task.category.name}`);
      return `- ${parts.join(" | ")}`;
    });
  const donePart =
    finished.length === 0
      ? "FINISHED IN THE LAST 7 DAYS: nothing."
      : `FINISHED IN THE LAST 7 DAYS (newest first):\n${finished.join("\n")}`;

  return `${openPart}\n\n${donePart}`;
}

function describeOpenTask(task: TaskDTO, now: Now): string {
  const parts = [task.title];
  if (task.dueDate) {
    const time = task.dueTime ? ` at ${formatTime(task.dueTime)}` : "";
    parts.push(`due ${relDay(task.dueDate, now.today)} (${task.dueDate})${time}`);
    if (isOverdue(task, now)) parts.push("OVERDUE");
  } else {
    parts.push("no due date");
  }
  parts.push(`${task.priority} priority`);
  if (task.category) parts.push(`category: ${task.category.name}`);
  if (task.repeat) parts.push(`repeats ${task.repeat}`);
  if (task.steps.length > 0) {
    const done = task.steps.filter((s) => s.done).length;
    const shown = task.steps.slice(0, CHAT_MAX_STEPS).map((s) => `${s.done ? "[x]" : "[ ]"} ${s.title}`);
    const more = task.steps.length > CHAT_MAX_STEPS ? `; …and ${task.steps.length - CHAT_MAX_STEPS} more` : "";
    parts.push(`steps ${done} of ${task.steps.length} done: ${shown.join("; ")}${more}`);
  }
  if (task.notes) {
    const notes = task.notes.replace(/\s+/g, " ").trim();
    parts.push(`notes: ${notes.length > CHAT_MAX_NOTES ? `${notes.slice(0, CHAT_MAX_NOTES)}…` : notes}`);
  }
  return parts.join(" | ");
}

// The task as plain text for a prompt. Goes inside asUserData().
function describe(task: TaskForClaude): string {
  const due = task.dueDate && `Due: ${task.dueDate}${task.dueTime ? ` at ${task.dueTime}` : ""}`;
  return [
    `Title: ${task.title}`,
    task.category && `Category: ${task.category}`,
    task.priority && `Priority: ${task.priority}`,
    due,
    task.repeat && `Repeats: ${task.repeat}`,
    task.notes && `Notes: ${task.notes}`,
    task.steps.length > 0 && `Steps already on the list:\n${task.steps.map((s) => `- ${s}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
}
