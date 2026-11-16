import "server-only";
import { getCurrentUser } from "./auth";
import { db } from "./db";
import { Prisma } from "@/generated/prisma/client";
import type { Priority, Repeat } from "@/generated/prisma/enums";
import { nextRepeatDate, nowIn } from "./dates";
import { getTimeZone } from "./timezone";

// ─────────────────────────────────────────────────────────────────────────────
// The ONLY file in the app that reads or writes tasks and categories.
//
// Rules every function here follows:
//   1. Start with getCurrentUser() — signed-out visitors never get past it.
//   2. Every query is filtered by that user's id, so nobody can see or change
//      someone else's tasks, even by guessing a task id.
//   3. Check all input (it can come from a form, and later from Claude), and
//      return plain, minimal objects — never raw database rows.
//
// Phase 6.5 will add database-level protection (row-level security) by
// changing just this file.
// ─────────────────────────────────────────────────────────────────────────────

export const PRIORITIES = ["high", "medium", "low"] as const satisfies readonly Priority[];
export const REPEATS = ["daily", "weekly", "monthly"] as const satisfies readonly Repeat[];

const MAX_TITLE = 200;
const MAX_NOTES = 5000;
const MAX_CATEGORY = 40;
const MAX_STEPS = 50;

// What the rest of the app gets back for a task. Dates are plain strings so
// they can be passed straight to the browser.
export type TaskDTO = {
  id: string;
  title: string;
  notes: string;
  priority: Priority;
  dueDate: string | null; // "YYYY-MM-DD"
  dueTime: string | null; // "HH:MM", 24-hour
  repeat: Repeat | null;
  done: boolean;
  doneAt: string | null; // ISO timestamp
  category: CategoryDTO | null;
  steps: StepDTO[]; // in order
  // Set only on the "Finished today" entry for one tick of a repeating task.
  // The task itself has already moved on to its next date (in dueDate);
  // unticking this entry undoes that tick.
  completionId: string | null;
};

export type CategoryDTO = { id: string; name: string };

// A step (the database calls them subtasks) in a task's checklist.
export type StepDTO = { id: string; title: string; done: boolean };

// What every task query loads alongside the task itself.
const taskInclude = {
  category: true,
  subtasks: {
    select: { id: true, title: true, done: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  },
} satisfies Prisma.TaskInclude;

// The fields someone can fill in when adding a task.
export type NewTaskInput = {
  title: string;
  notes?: string;
  priority?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  category?: string | null; // a name, e.g. "Fitness" — created if it's new
  repeat?: string | null; // "daily" | "weekly" | "monthly"; blank/null = doesn't repeat
  steps?: { title: string; done?: boolean }[]; // a new task's starting checklist
};

// When editing, every field is optional: only the ones you pass change.
// (Steps on an existing task are changed one at a time, with the step
// functions below.)
export type TaskChanges = Partial<Omit<NewTaskInput, "steps">>;

// Thrown when input is invalid or a task can't be found. The message is safe
// to show to the user.
export class TaskError extends Error {}

// ─── Reading ─────────────────────────────────────────────────────────────────

// Every task not yet done, soonest first; tasks with no date go last.
// (Which ones count as "overdue" or "today" depends on the user's own clock,
// so the screens work that out.)
export async function listOpenTasks(): Promise<TaskDTO[]> {
  const user = await getCurrentUser();
  const rows = await db.task.findMany({
    where: { userId: user.id, done: false },
    include: taskInclude,
    orderBy: [
      { dueDate: { sort: "asc", nulls: "last" } },
      { dueTime: { sort: "asc", nulls: "last" } },
      { priority: "asc" }, // high → medium → low (the order they're defined in)
      { title: "asc" },
    ],
  });
  return rows.map(toDTO);
}

// Finished tasks, most recently finished first.
export async function listDoneTasks(limit = 200): Promise<TaskDTO[]> {
  const user = await getCurrentUser();
  const rows = await db.task.findMany({
    where: { userId: user.id, done: true },
    include: taskInclude,
    orderBy: { doneAt: { sort: "desc", nulls: "last" } },
    take: limit,
  });
  return rows.map(toDTO);
}

// Everything finished in the last 36 hours, most recent first: one-off tasks
// that were ticked off, plus one entry per tick of a repeating task. The
// Today screen picks out the ones finished "today" in the user's own time
// zone (36h covers every time zone).
export async function listRecentlyDoneTasks(): Promise<TaskDTO[]> {
  const user = await getCurrentUser();
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000);
  const [rows, completions] = await Promise.all([
    db.task.findMany({
      where: { userId: user.id, done: true, doneAt: { gte: since } },
      include: taskInclude,
    }),
    db.taskCompletion.findMany({
      where: { createdAt: { gte: since }, task: { userId: user.id } },
      include: { task: { include: taskInclude } },
    }),
  ]);
  const entries: TaskDTO[] = [
    ...rows.map(toDTO),
    ...completions.map((c) => ({
      ...toDTO(c.task),
      done: true,
      doneAt: c.createdAt.toISOString(),
      completionId: c.id,
    })),
  ];
  // ISO timestamps sort correctly as text.
  return entries.sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
}

export async function getTask(id: string): Promise<TaskDTO | null> {
  const user = await getCurrentUser();
  if (!isUuid(id)) return null;
  const row = await db.task.findFirst({
    where: { id, userId: user.id },
    include: taskInclude,
  });
  return row ? toDTO(row) : null;
}

// The user's categories that are on at least one task, A–Z. Used for the
// suggestions list and filter chips. (Categories whose tasks were all deleted
// stay in the database, and get reused if you type the name again.)
export async function listCategories(): Promise<CategoryDTO[]> {
  const user = await getCurrentUser();
  return db.category.findMany({
    where: { userId: user.id, tasks: { some: {} } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export async function createTask(input: NewTaskInput): Promise<TaskDTO> {
  const user = await getCurrentUser();
  const title = cleanTitle(input.title);
  const dueDate = cleanDate(input.dueDate);
  const dueTime = dueDate ? cleanTime(input.dueTime) : null; // a time needs a date
  const categoryId = await categoryIdFor(user.id, input.category);

  const row = await db.task.create({
    data: {
      userId: user.id,
      title,
      notes: cleanNotes(input.notes),
      priority: cleanPriority(input.priority) ?? "medium",
      dueDate: dueDate ? dateToDb(dueDate) : null,
      dueTime,
      repeat: cleanRepeat(input.repeat),
      categoryId,
      subtasks: {
        create: cleanSteps(input.steps).map((step, position) => ({ ...step, position })),
      },
    },
    include: taskInclude,
  });
  return toDTO(row);
}

export async function updateTask(id: string, changes: TaskChanges): Promise<TaskDTO> {
  const user = await getCurrentUser();
  const current = await findOwnedTask(user.id, id);

  const data: Prisma.TaskUncheckedUpdateInput = {};
  if (changes.title !== undefined) data.title = cleanTitle(changes.title);
  if (changes.notes !== undefined) data.notes = cleanNotes(changes.notes);
  if (changes.priority !== undefined) {
    const priority = cleanPriority(changes.priority);
    if (!priority) throw new TaskError("Priority must be high, medium or low.");
    data.priority = priority;
  }
  if (changes.category !== undefined) data.categoryId = await categoryIdFor(user.id, changes.category);
  if (changes.repeat !== undefined) data.repeat = cleanRepeat(changes.repeat);

  // Date and time are checked together: clearing the date also clears the time.
  if (changes.dueDate !== undefined || changes.dueTime !== undefined) {
    const dueDate = changes.dueDate !== undefined ? cleanDate(changes.dueDate) : current.dueDate;
    const dueTime = changes.dueTime !== undefined ? cleanTime(changes.dueTime) : current.dueTime;
    data.dueDate = dueDate ? dateToDb(dueDate) : null;
    data.dueTime = dueDate ? dueTime : null;
  }

  const row = await db.task.update({
    where: { id: current.id, userId: user.id },
    data,
    include: taskInclude,
  });
  return toDTO(row);
}

// What happened when a task was ticked: a one-off task is simply done; a
// repeating one "rolled" on to its next date (and can be undone).
export type DoneResult =
  | { rolled: false }
  | { rolled: true; completionId: string; nextDate: string; today: string };

// Tick a task off, or untick it. Ticking a repeating task doesn't mark it
// done: it records the tick and moves the task to its next date instead.
export async function setTaskDone(id: string, done: boolean): Promise<DoneResult> {
  const user = await getCurrentUser();
  const current = await findOwnedTask(user.id, id);
  if (done && current.repeat && !current.done) {
    return completeRepeatingTask(user.id, { ...current, repeat: current.repeat });
  }
  await db.task.update({
    where: { id: current.id, userId: user.id },
    data: { done, doneAt: done ? new Date() : null },
  });
  return { rolled: false };
}

// Puts a repeating task back the way it was before one tick: its old due
// date, its ticked steps, and removes the tick from its history. Only the
// task's most recent tick can be undone, so the history never gets tangled.
export async function undoCompletion(completionId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!isUuid(completionId)) throw new TaskError("That's already been undone.");

  await db.$transaction(async (tx) => {
    const completion = await tx.taskCompletion.findFirst({
      where: { id: completionId, task: { userId: user.id } },
      select: { id: true, taskId: true, previousDueDate: true, stepsDone: true },
    });
    if (!completion) throw new TaskError("That's already been undone.");

    const latest = await tx.taskCompletion.findFirst({
      where: { taskId: completion.taskId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (latest?.id !== completion.id) throw new TaskError("Only the most recent tick of a task can be undone.");

    // deleteMany reports how many rows it removed: if two undos arrive at
    // once, only the first one goes on to change the task.
    const { count } = await tx.taskCompletion.deleteMany({ where: { id: completion.id } });
    if (count === 0) throw new TaskError("That's already been undone.");

    await tx.task.update({
      where: { id: completion.taskId, userId: user.id },
      data: { dueDate: completion.previousDueDate },
    });
    if (completion.stepsDone.length > 0) {
      // Steps deleted since then are simply skipped.
      await tx.subtask.updateMany({
        where: { taskId: completion.taskId, id: { in: completion.stepsDone } },
        data: { done: true },
      });
    }
  });
}

export async function deleteTask(id: string): Promise<void> {
  const user = await getCurrentUser();
  if (!isUuid(id)) throw new TaskError("That task doesn't exist.");
  // deleteMany lets us filter by userId too; it deletes 0 rows if the task
  // isn't yours. Its subtasks and history are removed with it (cascade).
  const { count } = await db.task.deleteMany({ where: { id, userId: user.id } });
  if (count === 0) throw new TaskError("That task doesn't exist.");
}

// ─── Steps ───────────────────────────────────────────────────────────────────
// A step belongs to a task, so "is this yours?" is checked through its task.

// Adds a step to the end of a task's checklist.
export async function addStep(taskId: string, title: string): Promise<StepDTO> {
  const user = await getCurrentUser();
  const task = await findOwnedTask(user.id, taskId);
  const clean = cleanStepTitle(title);

  const { _count, _max } = await db.subtask.aggregate({
    where: { taskId: task.id },
    _count: true,
    _max: { position: true },
  });
  if (_count >= MAX_STEPS) throw new TaskError(`A task can have up to ${MAX_STEPS} steps.`);

  return db.subtask.create({
    data: { taskId: task.id, title: clean, position: (_max.position ?? -1) + 1 },
    select: { id: true, title: true, done: true },
  });
}

export async function setStepDone(stepId: string, done: boolean): Promise<void> {
  const user = await getCurrentUser();
  if (!isUuid(stepId)) throw new TaskError("That step doesn't exist.");
  // updateMany lets us filter by the task's owner too; it changes 0 rows if
  // the step isn't yours.
  const { count } = await db.subtask.updateMany({
    where: { id: stepId, task: { userId: user.id } },
    data: { done },
  });
  if (count === 0) throw new TaskError("That step doesn't exist.");
}

export async function deleteStep(stepId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!isUuid(stepId)) throw new TaskError("That step doesn't exist.");
  const { count } = await db.subtask.deleteMany({ where: { id: stepId, task: { userId: user.id } } });
  if (count === 0) throw new TaskError("That step doesn't exist.");
}

// ─── Helpers (private to this file) ──────────────────────────────────────────

type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

function toDTO(row: TaskRow): TaskDTO {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    priority: row.priority,
    dueDate: row.dueDate ? dateFromDb(row.dueDate) : null,
    dueTime: row.dueTime,
    repeat: row.repeat,
    done: row.done,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    category: row.category ? { id: row.category.id, name: row.category.name } : null,
    steps: row.subtasks,
    completionId: null,
  };
}

// Loads a task only if it belongs to this user; otherwise acts as if it
// doesn't exist (so nobody can learn which ids are real).
async function findOwnedTask(userId: string, id: string) {
  if (!isUuid(id)) throw new TaskError("That task doesn't exist.");
  const row = await db.task.findFirst({
    where: { id, userId },
    select: { id: true, dueDate: true, dueTime: true, repeat: true, done: true },
  });
  if (!row) throw new TaskError("That task doesn't exist.");
  return { ...row, dueDate: row.dueDate ? dateFromDb(row.dueDate) : null };
}

// Records one tick of a repeating task, moves it to its next date and
// unticks its steps — all together or not at all (a "transaction").
async function completeRepeatingTask(
  userId: string,
  task: { id: string; dueDate: string | null; repeat: Repeat },
): Promise<DoneResult> {
  // "Today" in the user's own time zone, not the server's.
  const { today } = nowIn(await getTimeZone());
  const nextDate = nextRepeatDate(task.repeat, task.dueDate, today);

  const completionId = await db.$transaction(async (tx) => {
    // Only moves the task if it still has the due date we just read, so a
    // quick double tap can't push it forward twice.
    const { count } = await tx.task.updateMany({
      where: { id: task.id, userId, done: false, dueDate: task.dueDate ? dateToDb(task.dueDate) : null },
      data: { dueDate: dateToDb(nextDate) },
    });
    if (count === 0) throw new TaskError("That task just changed. Try again.");

    const ticked = await tx.subtask.findMany({ where: { taskId: task.id, done: true }, select: { id: true } });
    if (ticked.length > 0) {
      await tx.subtask.updateMany({ where: { taskId: task.id, done: true }, data: { done: false } });
    }
    const completion = await tx.taskCompletion.create({
      data: {
        taskId: task.id,
        completedOn: dateToDb(today),
        previousDueDate: task.dueDate ? dateToDb(task.dueDate) : null,
        stepsDone: ticked.map((s) => s.id),
      },
      select: { id: true },
    });
    return completion.id;
  });

  return { rolled: true, completionId, nextDate, today };
}

// Turns a typed category name into its id, creating the category the first
// time it's used. Blank means "no category".
async function categoryIdFor(userId: string, name: string | null | undefined): Promise<string | null> {
  const clean = (name ?? "").trim().replace(/\s+/g, " ");
  if (!clean) return null;
  if (clean.length > MAX_CATEGORY) throw new TaskError(`Category names can be up to ${MAX_CATEGORY} characters.`);

  // Reuse an existing category even if the capitals differ ("fitness" → "Fitness").
  const existing = await db.category.findFirst({
    where: { userId, name: { equals: clean, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) return existing.id;

  // upsert (not create) so two saves at the same moment can't make duplicates.
  const created = await db.category.upsert({
    where: { userId_name: { userId, name: clean } },
    create: { userId, name: clean },
    update: {},
    select: { id: true },
  });
  return created.id;
}

function cleanTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title) throw new TaskError("Give the task a title.");
  if (title.length > MAX_TITLE) throw new TaskError(`Titles can be up to ${MAX_TITLE} characters.`);
  return title;
}

function cleanNotes(value: unknown): string {
  const notes = typeof value === "string" ? value.trim() : "";
  if (notes.length > MAX_NOTES) throw new TaskError(`Notes can be up to ${MAX_NOTES} characters.`);
  return notes;
}

function cleanPriority(value: unknown): Priority | null {
  return PRIORITIES.find((p) => p === value) ?? null;
}

function cleanStepTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title) throw new TaskError("Give the step a name.");
  if (title.length > MAX_TITLE) throw new TaskError(`Steps can be up to ${MAX_TITLE} characters.`);
  return title;
}

// A new task's starting steps. Blank ones are skipped.
function cleanSteps(value: unknown): { title: string; done: boolean }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TaskError("Something went wrong with the steps.");
  const steps = value
    .filter((s) => typeof s?.title === "string" && s.title.trim() !== "")
    .map((s) => ({ title: cleanStepTitle(s.title), done: s.done === true }));
  if (steps.length > MAX_STEPS) throw new TaskError(`A task can have up to ${MAX_STEPS} steps.`);
  return steps;
}

// Blank/null means "doesn't repeat"; anything else must be a known repeat.
function cleanRepeat(value: unknown): Repeat | null {
  if (value === null || value === undefined || value === "") return null;
  const repeat = REPEATS.find((r) => r === value);
  if (!repeat) throw new TaskError("Repeats must be daily, weekly or monthly.");
  return repeat;
}

// Accepts "YYYY-MM-DD" for a real calendar day; blank/null means no date.
function cleanDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TaskError("Dates must look like 2026-11-15.");
  }
  // Rejects impossible days like 2026-02-30.
  if (dateFromDb(dateToDb(value)) !== value) throw new TaskError("That date doesn't exist.");
  return value;
}

// Accepts "HH:MM" (24-hour); blank/null means no time.
function cleanTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new TaskError("Times must look like 09:30 or 17:00.");
  }
  return value;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// The database stores due dates as a plain day (no time or timezone). Using
// midnight UTC on the way in and out keeps the day from shifting by one.
function dateToDb(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function dateFromDb(date: Date): string {
  return date.toISOString().slice(0, 10);
}
