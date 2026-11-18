import "server-only";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { MODEL, USER_DATA_RULE, asUserData, getClaude } from "./claude";
import { MAX_TITLE } from "./tasks";

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
  const stream = getClaude().messages.stream(
    {
      model: MODEL,
      max_tokens: 4000,
      // Short answers to everyday questions: low effort keeps them quick and cheap.
      output_config: { effort: "low" },
      system: ASK_PROMPT,
      messages: [
        {
          role: "user",
          // The question is the user's own request, so it sits outside <user_data>.
          content: `Today is ${today}.\n\n${asUserData(describe(task))}\n\nMy question about this task: ${question}`,
        },
      ],
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
