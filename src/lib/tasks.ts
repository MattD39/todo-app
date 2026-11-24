import "server-only";
import { getCurrentUser } from "./auth";
import { runAsUser, type Db } from "./db";
import { Prisma } from "@/generated/prisma/client";
import type { Priority, Repeat } from "@/generated/prisma/enums";
import { addDays, isValidDay, nextRepeatDate, nowIn } from "./dates";
import { getTimeZone } from "./timezone";

// ─────────────────────────────────────────────────────────────────────────────
// The ONLY file in the app that reads or writes tasks and categories.
//
// Rules every function here follows:
//   1. Go through asCurrentUser() — it checks who's signed in (signed-out
//      visitors never get past it) and runs the queries as that user, so the
//      database's own row level security rules only show that user's rows.
//   2. Still filter every query by that user's id too: two locks, so a mistake
//      in either one alone can't leak someone else's tasks.
//   3. Check all input (it can come from a form, and later from Claude), and
//      return plain, minimal objects — never raw database rows.
// ─────────────────────────────────────────────────────────────────────────────

export const PRIORITIES = ["high", "medium", "low"] as const satisfies readonly Priority[];
export const REPEATS = ["daily", "weekly", "monthly"] as const satisfies readonly Repeat[];

export const MAX_TITLE = 200;
export const MAX_NOTES = 5000;
export const MAX_CATEGORY = 40;
export const MAX_STEPS = 50;

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
  const rows = await asCurrentUser((tx, userId) =>
    tx.task.findMany({
      where: { userId, done: false },
      include: taskInclude,
      orderBy: [
        { dueDate: { sort: "asc", nulls: "last" } },
        { dueTime: { sort: "asc", nulls: "last" } },
        { priority: "asc" }, // high → medium → low (the order they're defined in)
        { title: "asc" },
      ],
    }),
  );
  return rows.map(toDTO);
}

// The Done tab: finished tasks AND each tick of a repeating task (a repeating
// task is never "done": ticking it records an entry and moves it to its next
// date), newest first, at most `limit` in all. An entry has a completionId,
// so swiping or batch-deleting it removes only that entry. Only a task's most
// recent entry can be un-ticked (isLatest), the same rule as the Calendar.
export async function listDoneTasks(limit = 200): Promise<(TaskDTO | TickDTO)[]> {
  const [rows, completions, latest] = await asCurrentUser(async (tx, userId) => {
    const rows = await tx.task.findMany({
      where: { userId, done: true },
      include: taskInclude,
      orderBy: { doneAt: { sort: "desc", nulls: "last" } },
      take: limit,
    });
    const completions = await tx.taskCompletion.findMany({
      where: { task: { userId } },
      include: { task: { include: taskInclude } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    // The most recent tick of each of those tasks.
    const latest = await tx.taskCompletion.findMany({
      where: { taskId: { in: [...new Set(completions.map((c) => c.taskId))] }, task: { userId } },
      orderBy: { createdAt: "desc" },
      distinct: ["taskId"],
      select: { id: true },
    });
    return [rows, completions, latest] as const;
  });
  const latestIds = new Set(latest.map((c) => c.id));
  const entries: (TaskDTO | TickDTO)[] = [
    ...rows.map(toDTO),
    ...completions.map(
      (c): TickDTO => ({
        ...toDTO(c.task),
        done: true,
        doneAt: c.createdAt.toISOString(),
        completionId: c.id,
        completedOn: dateFromDb(c.completedOn),
        previousDueDate: c.previousDueDate ? dateFromDb(c.previousDueDate) : null,
        isLatest: latestIds.has(c.id),
      }),
    ),
  ];
  // ISO timestamps sort correctly as text; a task with no finish time goes last.
  return entries.sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? "")).slice(0, limit);
}

// Everything finished in the last 36 hours, most recent first: one-off tasks
// that were ticked off, plus one entry per tick of a repeating task. The
// Today screen picks out the ones finished "today" in the user's own time
// zone (36h covers every time zone).
export async function listRecentlyDoneTasks(): Promise<TaskDTO[]> {
  const [rows, completions] = await asCurrentUser(async (tx, userId) => {
    // Read the clock only after the login check (see asCurrentUser).
    const since = new Date(Date.now() - 36 * 60 * 60 * 1000);
    return [
      await tx.task.findMany({
        where: { userId, done: true, doneAt: { gte: since } },
        include: taskInclude,
      }),
      await tx.taskCompletion.findMany({
        where: { createdAt: { gte: since }, task: { userId } },
        include: { task: { include: taskInclude } },
      }),
    ] as const;
  });
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

// One tick of a repeating task, for the Calendar's history.
export type TickDTO = TaskDTO & {
  completionId: string;
  completedOn: string; // the day it was ticked
  previousDueDate: string | null; // the day it was due then
  isLatest: boolean; // only a task's most recent tick can be undone
};

export type HistoryDTO = { done: TaskDTO[]; ticks: TickDTO[] };

// What was finished between two days (inclusive), for the Calendar:
// one-off tasks ticked off then, and repeating-task ticks that were either
// done or due in that range (so the due day can say "Done early on …").
export async function listHistory(from: string, to: string): Promise<HistoryDTO> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new TaskError("That isn't a valid date range.");
  }
  const [rows, completions, latest] = await asCurrentUser(async (tx, userId) => {
    // doneAt is a moment in time; which day that was depends on the user's time
    // zone, so fetch a day either side and let the screen pick the exact days.
    const rows = await tx.task.findMany({
      where: {
        userId,
        done: true,
        doneAt: { gte: dateToDb(addDays(from, -1)), lt: dateToDb(addDays(to, 2)) },
      },
      include: taskInclude,
    });
    const completions = await tx.taskCompletion.findMany({
      where: {
        task: { userId },
        OR: [
          { completedOn: { gte: dateToDb(from), lte: dateToDb(to) } },
          { previousDueDate: { gte: dateToDb(from), lte: dateToDb(to) } },
        ],
      },
      include: { task: { include: taskInclude } },
    });
    // The most recent tick of each of those tasks (it may be outside the range).
    const latest = await tx.taskCompletion.findMany({
      where: { taskId: { in: [...new Set(completions.map((c) => c.taskId))] }, task: { userId } },
      orderBy: { createdAt: "desc" },
      distinct: ["taskId"],
      select: { id: true },
    });
    return [rows, completions, latest] as const;
  });
  const latestIds = new Set(latest.map((c) => c.id));

  return {
    done: rows.map(toDTO),
    ticks: completions.map((c) => ({
      ...toDTO(c.task),
      done: true,
      doneAt: c.createdAt.toISOString(),
      completionId: c.id,
      completedOn: dateFromDb(c.completedOn),
      previousDueDate: c.previousDueDate ? dateFromDb(c.previousDueDate) : null,
      isLatest: latestIds.has(c.id),
    })),
  };
}

export async function getTask(id: string): Promise<TaskDTO | null> {
  if (!isUuid(id)) {
    await getCurrentUser(); // still turn signed-out visitors away first
    return null;
  }
  const row = await asCurrentUser((tx, userId) =>
    tx.task.findFirst({
      where: { id, userId },
      include: taskInclude,
    }),
  );
  return row ? toDTO(row) : null;
}

// The categories that get a filter chip, A–Z: a saved category while any task
// has it (finished ones included), and a one-off only while an unfinished
// task has it, so its chip goes once they're all finished or deleted (the
// user's rule). (Categories with no tasks stay in the database, and get
// reused if you type the name again.)
export async function listCategories(): Promise<CategoryDTO[]> {
  return asCurrentUser((tx, userId) =>
    tx.category.findMany({
      where: {
        userId,
        OR: [
          { saved: true, tasks: { some: {} } },
          { saved: false, tasks: { some: { done: false } } },
        ],
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  );
}

// The saved list's names, A–Z, for the task sheet's Category list.
export async function listSavedCategoryNames(): Promise<string[]> {
  const rows = await asCurrentUser((tx, userId) =>
    tx.category.findMany({ where: { userId, saved: true }, select: { name: true }, orderBy: { name: "asc" } }),
  );
  return rows.map((r) => r.name);
}

// ─── Saved categories ("like contacts") ──────────────────────────────────────
// A category is either on the saved list (offered in the task sheet, managed
// in Settings → Categories) or a one-off typed for some task(s) only. Typing a
// name that matches a saved one, whatever its capitals, uses the saved one.
// New accounts start with Work, Fitness, Errands and Personal (a database
// trigger adds them; see the saved_categories migration).

// A saved category with how many tasks use it (finished ones included).
export type SavedCategory = { id: string; name: string; tasks: number; finished: number };

// Your saved list, A to Z, with how many tasks use each.
export async function listSavedCategories(): Promise<SavedCategory[]> {
  const rows = await asCurrentUser((tx, userId) =>
    tx.category.findMany({
      where: { userId, saved: true },
      select: {
        id: true,
        name: true,
        _count: { select: { tasks: true } },
        tasks: { where: { done: true }, select: { id: true } },
      },
      orderBy: { name: "asc" },
    }),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, tasks: r._count.tasks, finished: r.tasks.length }));
}

// One-offs in use: categories that aren't saved but some unfinished task has
// (Settings → Categories → "Not saved", each with a Save button). A to Z.
export async function listOneOffCategories(): Promise<{ id: string; name: string; tasks: number }[]> {
  const rows = await asCurrentUser((tx, userId) =>
    tx.category.findMany({
      where: { userId, saved: false, tasks: { some: { done: false } } },
      select: { id: true, name: true, _count: { select: { tasks: { where: { done: false } } } } },
      orderBy: { name: "asc" },
    }),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, tasks: r._count.tasks }));
}

// Puts a category on the saved list: "Add" in Settings, "Add category…" and
// "Save to list" in the task sheet, and Claude's save action (only after you
// say yes). A one-off with that name (any capitals) becomes saved, keeping
// its tasks; otherwise a new saved category is made. Returns its name and
// whether it was already saved (then nothing changed).
export async function saveCategory(name: unknown): Promise<{ name: string; alreadySaved: boolean }> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  const clean = cleanCategoryName(name);
  return asCurrentUser(async (tx, userId) => {
    const existing = await tx.category.findFirst({
      where: { userId, name: { equals: clean, mode: "insensitive" } },
      select: { id: true, name: true, saved: true },
    });
    if (existing?.saved) return { name: existing.name, alreadySaved: true };
    if (existing) {
      await tx.category.update({ where: { id: existing.id, userId }, data: { saved: true } });
      return { name: existing.name, alreadySaved: false };
    }
    const created = await tx.category.upsert({
      where: { userId_name: { userId, name: clean } },
      create: { userId, name: clean, saved: true },
      update: { saved: true },
      select: { name: true },
    });
    return { name: created.name, alreadySaved: false };
  });
}

// Renames a saved category (its tasks follow, since they point at it). Only
// changing its capitals is fine; a name another category already has isn't.
export async function renameCategory(id: unknown, name: unknown): Promise<string> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!isUuid(id)) throw new TaskError("That category doesn't exist.");
  const clean = cleanCategoryName(name);
  return asCurrentUser(async (tx, userId) => {
    const category = await tx.category.findFirst({ where: { id, userId, saved: true }, select: { id: true } });
    if (!category) throw new TaskError("That category doesn't exist.");
    const clash = await tx.category.findFirst({
      where: { userId, id: { not: id }, name: { equals: clean, mode: "insensitive" } },
      select: { name: true },
    });
    if (clash) throw new TaskError(`You already have a category called “${clash.name}”.`);
    await tx.category.update({ where: { id, userId }, data: { name: clean } });
    return clean;
  });
}

// How many tasks would lose a saved category if it were deleted, for the
// "Delete Work? 12 tasks will lose this category (3 of them finished)." box.
export async function categoryUsage(id: unknown): Promise<{ name: string; tasks: number; finished: number }> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!isUuid(id)) throw new TaskError("That category doesn't exist.");
  return asCurrentUser(async (tx, userId) => {
    const category = await tx.category.findFirst({ where: { id, userId, saved: true }, select: { name: true } });
    if (!category) throw new TaskError("That category doesn't exist.");
    const [tasks, finished] = await Promise.all([
      tx.task.count({ where: { userId, categoryId: id } }),
      tx.task.count({ where: { userId, categoryId: id, done: true } }),
    ]);
    return { name: category.name, tasks, finished };
  });
}

// Deletes a saved category (only from Settings). Every task that had it keeps
// going with no category, so its chip goes too. Returns how many tasks lost it.
export async function deleteSavedCategory(id: unknown): Promise<number> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!isUuid(id)) throw new TaskError("That category doesn't exist.");
  return asCurrentUser(async (tx, userId) => {
    const category = await tx.category.findFirst({ where: { id, userId, saved: true }, select: { id: true } });
    if (!category) throw new TaskError("That category doesn't exist.");
    // Done by hand (rather than relying on the database's "set to empty" rule)
    // so the count is exact and it's plain what happens to the tasks.
    const { count } = await tx.task.updateMany({ where: { userId, categoryId: id }, data: { categoryId: null } });
    await tx.category.deleteMany({ where: { id, userId } });
    return count;
  });
}

// A category name as typed: spaces tidied, not empty, not too long.
function cleanCategoryName(name: unknown): string {
  const clean = (typeof name === "string" ? name : "").trim().replace(/\s+/g, " ");
  if (!clean) throw new TaskError("Type a name for the category.");
  if (clean.length > MAX_CATEGORY) throw new TaskError(`Category names can be up to ${MAX_CATEGORY} characters.`);
  return clean;
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export async function createTask(input: NewTaskInput): Promise<TaskDTO> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  const title = cleanTitle(input.title);
  const dueDate = cleanDate(input.dueDate);
  const dueTime = dueDate ? cleanTime(input.dueTime) : null; // a time needs a date
  const notes = cleanNotes(input.notes);
  const priority = cleanPriority(input.priority) ?? "medium";
  const repeat = cleanRepeat(input.repeat);
  const steps = cleanSteps(input.steps);

  // One transaction: if saving the task fails, a brand-new category isn't left behind.
  const row = await asCurrentUser(async (tx, userId) =>
    tx.task.create({
      data: {
        userId,
        title,
        notes,
        priority,
        dueDate: dueDate ? dateToDb(dueDate) : null,
        dueTime,
        repeat,
        categoryId: await categoryIdFor(tx, userId, input.category),
        subtasks: {
          create: steps.map((step, position) => ({ ...step, position })),
        },
      },
      include: taskInclude,
    }),
  );
  return toDTO(row);
}

export async function updateTask(id: string, changes: TaskChanges): Promise<TaskDTO> {
  const row = await asCurrentUser(async (tx, userId) => {
    const current = await findOwnedTask(tx, userId, id);

    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (changes.title !== undefined) data.title = cleanTitle(changes.title);
    if (changes.notes !== undefined) data.notes = cleanNotes(changes.notes);
    if (changes.priority !== undefined) {
      const priority = cleanPriority(changes.priority);
      if (!priority) throw new TaskError("Priority must be high, medium or low.");
      data.priority = priority;
    }
    if (changes.category !== undefined) data.categoryId = await categoryIdFor(tx, userId, changes.category);
    if (changes.repeat !== undefined) data.repeat = cleanRepeat(changes.repeat);

    // Date and time are checked together: clearing the date also clears the time.
    if (changes.dueDate !== undefined || changes.dueTime !== undefined) {
      const dueDate = changes.dueDate !== undefined ? cleanDate(changes.dueDate) : current.dueDate;
      const dueTime = changes.dueTime !== undefined ? cleanTime(changes.dueTime) : current.dueTime;
      data.dueDate = dueDate ? dateToDb(dueDate) : null;
      data.dueTime = dueDate ? dueTime : null;
    }

    return tx.task.update({
      where: { id: current.id, userId },
      data,
      include: taskInclude,
    });
  });
  return toDTO(row);
}

// What happened when a task was ticked: a one-off task is simply done; a
// repeating one "rolled" on to its next date (and can be undone).
export type DoneResult = { rolled: false } | { rolled: true; completionId: string; nextDate: string; today: string };

// Tick a task off, or untick it. Ticking a repeating task doesn't mark it
// done: it records the tick and moves the task to its next date instead.
export async function setTaskDone(id: string, done: boolean): Promise<DoneResult> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  // "Today" in the user's own time zone, not the server's (needed if it repeats).
  const { today } = nowIn(await getTimeZone());
  return asCurrentUser(async (tx, userId): Promise<DoneResult> => {
    const current = await findOwnedTask(tx, userId, id);
    if (done && current.repeat && !current.done) {
      return completeRepeatingTask(tx, userId, { ...current, repeat: current.repeat }, today);
    }
    await tx.task.update({
      where: { id: current.id, userId },
      data: { done, doneAt: done ? new Date() : null },
    });
    return { rolled: false };
  });
}

// Puts a repeating task back the way it was before one tick: its old due
// date, its ticked steps, and removes the tick from its history. Only the
// task's most recent tick can be undone, so the history never gets tangled.
export async function undoCompletion(completionId: string): Promise<void> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!isUuid(completionId)) throw new TaskError("That's already been undone.");

  // All of this is one transaction: it all happens, or none of it does.
  await asCurrentUser(async (tx, userId) => {
    const completion = await tx.taskCompletion.findFirst({
      where: { id: completionId, task: { userId } },
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
      where: { id: completion.taskId, userId },
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

// Deletes a task for good: NOT kept in Recently deleted. Only for undoing a
// task Claude added in Chat (undoing an add, not deleting a task of yours).
// Deleting a task yourself goes through deleteTaskWithCopy, which bins it.
export async function deleteTask(id: string): Promise<void> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!isUuid(id)) throw new TaskError("That task doesn't exist.");
  // deleteMany lets us filter by userId too; it deletes 0 rows if the task
  // isn't yours. Its subtasks and history are removed with it (cascade).
  const { count } = await asCurrentUser((tx, userId) => tx.task.deleteMany({ where: { id, userId } }));
  if (count === 0) throw new TaskError("That task doesn't exist.");
}

// ─── Delete with Undo (swipe to delete) ──────────────────────────────────────
// The delete is real and happens at once: the rows are gone from the
// database (so nothing, Claude included, can see them). For a few seconds
// the screen keeps the copy returned here, and Undo hands it back to be
// put back exactly as it was, with the same ids.

// Everything needed to put a deleted task back: the task, its steps and the
// history of its ticks (if it repeats).
export type DeletedTask = {
  id: string;
  title: string;
  notes: string;
  priority: string;
  dueDate: string | null; // "YYYY-MM-DD"
  dueTime: string | null;
  repeat: string | null;
  done: boolean;
  doneAt: string | null; // ISO
  category: string | null; // its name
  createdAt: string; // ISO
  steps: { id: string; title: string; done: boolean; position: number; createdAt: string }[];
  ticks: DeletedTick[];
};

// One tick of a repeating task (one entry in its history).
export type DeletedTick = {
  id: string;
  taskId: string;
  completedOn: string; // "YYYY-MM-DD"
  previousDueDate: string | null;
  stepsDone: string[];
  createdAt: string; // ISO
};

// Deletes a whole task (steps and history too) and returns a copy for Undo.
export async function deleteTaskWithCopy(id: string): Promise<DeletedTask> {
  return asCurrentUser(async (tx, userId) => {
    const current = await findOwnedTask(tx, userId, id);
    const row = await tx.task.findFirstOrThrow({ where: { id: current.id, userId }, include: COPY_INCLUDE });
    const { count } = await tx.task.deleteMany({ where: { id: row.id, userId } });
    if (count === 0) throw new TaskError("That task doesn't exist.");
    const copy = copyOf(row);
    // In the same transaction: the task is never gone without its copy
    // being safely in the bin.
    await putInBin(tx, userId, copy);
    return copy;
  });
}

// Everything a deleted task's copy needs (steps in order, its whole history).
const COPY_INCLUDE = {
  category: true,
  subtasks: { orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }] },
  completions: { orderBy: { createdAt: "asc" as const } },
};

function copyOf(row: Prisma.TaskGetPayload<{ include: typeof COPY_INCLUDE }>): DeletedTask {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    priority: row.priority,
    dueDate: row.dueDate ? dateFromDb(row.dueDate) : null,
    dueTime: row.dueTime,
    repeat: row.repeat,
    done: row.done,
    doneAt: row.doneAt?.toISOString() ?? null,
    category: row.category?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    steps: row.subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      done: s.done,
      position: s.position,
      createdAt: s.createdAt.toISOString(),
    })),
    ticks: row.completions.map(tickCopy),
  };
}

// ─── Deleting several at once (Edit mode on the task lists) ──────────────────

// Most rows one batch can delete (a screen never shows anywhere near this).
export const MAX_BATCH_DELETE = 200;

// What a batch delete did. The task ids and tick copies are for Undo.
export type BatchDeleteResult = {
  tasks: number; // whole tasks deleted (each now in Recently deleted)
  entries: number; // "Finished today" entries deleted (one tick of a repeating task)
  missing: number; // already gone (deleted elsewhere), so skipped
  taskIds: string[];
  ticks: DeletedTick[];
};

// Deletes the selected rows in one go: whole tasks (each copied into Recently
// deleted, exactly like swipe to delete) and single entries of repeating
// tasks (like swiping one). All in one transaction: everything happens or
// nothing does. Rows that are already gone, or aren't this user's, are
// skipped and counted as missing. An entry whose task is in the same batch
// goes with its task. `targets` comes from the browser, so it's checked here.
export async function deleteManyWithCopies(targets: unknown): Promise<BatchDeleteResult> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!Array.isArray(targets) || targets.length === 0) throw new TaskError("Nothing was selected.");
  if (targets.length > MAX_BATCH_DELETE) {
    throw new TaskError(`You can delete up to ${MAX_BATCH_DELETE} at a time.`);
  }
  const taskIds = new Set<string>();
  const tickIds = new Set<string>();
  for (const target of targets) {
    const { taskId, completionId } = asObject(target);
    if (isUuid(taskId)) taskIds.add(taskId);
    else if (isUuid(completionId)) tickIds.add(completionId);
    else throw new TaskError("Something went wrong. Try again.");
  }

  return asCurrentUser(async (tx, userId) => {
    // Read first (a fixed number of queries, however many are selected, so a
    // big batch stays quick).
    const rows = await tx.task.findMany({ where: { id: { in: [...taskIds] }, userId }, include: COPY_INCLUDE });
    const ticks = await tx.taskCompletion.findMany({
      where: { id: { in: [...tickIds] }, task: { userId } },
      include: { task: { select: { title: true } } },
    });
    const deletingTask = new Set(rows.map((r) => r.id));
    const ownTicks = ticks.filter((t) => !deletingTask.has(t.taskId)); // the rest go with their task

    // Into the bin in one statement, in the same transaction as the delete,
    // so nothing is ever gone without its copy being safely in the bin.
    // Tasks and single entries both go in (an entry like swipe deleting one).
    if (rows.length + ownTicks.length > 0) {
      await clearOldFromBin(tx, userId);
      await binCopies(tx, userId, [...rows.map(copyOf), ...ownTicks.map((t) => tickBinCopy(t, t.task.title))]);
    }
    if (rows.length > 0) await tx.task.deleteMany({ where: { id: { in: [...deletingTask] }, userId } });
    if (ownTicks.length > 0) {
      await tx.taskCompletion.deleteMany({ where: { id: { in: ownTicks.map((t) => t.id) }, task: { userId } } });
    }

    return {
      tasks: rows.length,
      entries: ownTicks.length,
      missing: taskIds.size - rows.length + (tickIds.size - ticks.length),
      taskIds: rows.map((r) => r.id),
      ticks: ownTicks.map(tickCopy),
    };
  });
}

// ─── Recently deleted (the bin in Settings) ──────────────────────────────────
// Every task you delete (swipe, edit mode, or Delete in the task editor) is
// kept here as a copy for BIN_DAYS days, then cleared out, and so is every
// single entry of a repeating task you delete (see "Entries in Recently
// deleted"). Not binned: a task Claude added that you Undo in Chat (deleteTask).

export const BIN_DAYS = 30;

// Puts a deleted task's copy in the bin, and clears out your own copies that
// are past their 30 days while it's here.
async function putInBin(tx: Db, userId: string, copy: DeletedTask) {
  await clearOldFromBin(tx, userId);
  // A task deleted again after a restore replaces its old copy.
  await tx.recentlyDeleted.deleteMany({ where: { id: copy.id, userId } });
  // Written by hand, like ClaudeUsage in usage.ts: app_user may only fill in
  // these three columns (the database clock sets deletedAt), and the database
  // refuses Prisma's own create here.
  await tx.$executeRaw`
    INSERT INTO "RecentlyDeleted" ("id", "userId", "copy")
    VALUES (${copy.id}::uuid, ${userId}::uuid, ${JSON.stringify(copy)}::jsonb)`;
}

async function clearOldFromBin(tx: Db, userId: string) {
  await tx.recentlyDeleted.deleteMany({ where: { userId, deletedAt: { lt: binCutoff() } } });
}

// Copies deleted before this moment are past their 30 days.
function binCutoff(): Date {
  return new Date(Date.now() - BIN_DAYS * 24 * 60 * 60 * 1000);
}

// One task in Recently deleted, as the list in Settings shows it.
// A whole task, or one entry of a repeating task (ticked: the day it was
// ticked, "YYYY-MM-DD"; title: its task's title then).
export type BinItem =
  | { id: string; kind: "task"; title: string; deletedAt: string /* ISO */ }
  | { id: string; kind: "tick"; title: string; ticked: string; deletedAt: string };

const MAX_BIN_LIST = 500;

// Your recently deleted tasks, newest first. Copies past their 30 days are
// cleared out first, and never listed even if one slipped through.
export async function listRecentlyDeleted(): Promise<BinItem[]> {
  return asCurrentUser(async (tx, userId) => {
    await clearOldFromBin(tx, userId);
    // Only a few fields are read from each copy (a copy can be large).
    const rows = await tx.$queryRaw<
      { id: string; title: string | null; kind: string | null; ticked: string | null; deletedAt: Date }[]
    >`
      SELECT "id", "copy"->>'title' AS "title", "copy"->>'kind' AS "kind",
             "copy"->>'completedOn' AS "ticked", "deletedAt"
      FROM "RecentlyDeleted"
      WHERE "userId" = ${userId}::uuid AND "deletedAt" >= ${binCutoff()}
      ORDER BY "deletedAt" DESC
      LIMIT ${MAX_BIN_LIST}`;
    return rows.map((r): BinItem => {
      const title = (r.title ?? "").slice(0, MAX_TITLE) || "Untitled task";
      const deletedAt = r.deletedAt.toISOString();
      return r.kind === "tick" && r.ticked && isValidDay(r.ticked)
        ? { id: r.id, kind: "tick", title, ticked: r.ticked, deletedAt }
        : { id: r.id, kind: "task", title, deletedAt };
    });
  });
}

// Restore: puts a task from the bin back on your lists, exactly as it was
// (same id, steps, history and category). Returns its title.
// What Restore did: the item is back (`restored`: the task's title), or it's
// an entry whose task is itself in Recently deleted (`needsTask`: that task's
// title), so the screen can offer "Restore both".
export type RestoreResult = { restored: string } | { needsTask: string };

export async function restoreFromBin(id: string): Promise<RestoreResult> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!isUuid(id)) throw new TaskError(NOT_IN_BIN);
  return asCurrentUser(async (tx, userId) => {
    const row = await tx.recentlyDeleted.findFirst({
      where: { id, userId, deletedAt: { gte: binCutoff() } },
      select: { copy: true },
    });
    if (!row) throw new TaskError(NOT_IN_BIN);
    const copy = asObject(row.copy);
    if (copy.kind !== "tick") return { restored: await restoreCopy(tx, userId, row.copy) };

    // An entry: put the tick back on its task (the task's date doesn't change).
    const title = typeof copy.title === "string" ? copy.title : "this task";
    const result = await restoreTicksFromBin(tx, userId, [id]);
    if (result.restored === 1) return { restored: title };
    if (result.alreadyBack === 1) throw new TaskError("It's already back.");
    if (result.needTask.length === 1) return { needsTask: title };
    throw new TaskError("Its task was deleted forever, so this entry can't come back.");
  });
}

// "Restore both": an entry and its task, both from Recently deleted, in one
// transaction (the task first, then the entry onto it).
export async function restoreEntryAndTask(id: string): Promise<string> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!isUuid(id)) throw new TaskError(NOT_IN_BIN);
  return asCurrentUser(async (tx, userId) => {
    const row = await tx.recentlyDeleted.findFirst({
      where: { id, userId, deletedAt: { gte: binCutoff() } },
      select: { copy: true },
    });
    const copy = asObject(row?.copy);
    if (!row || copy.kind !== "tick" || !isUuid(copy.taskId)) throw new TaskError(NOT_IN_BIN);
    const taskRow = await tx.recentlyDeleted.findFirst({
      where: { id: copy.taskId, userId, deletedAt: { gte: binCutoff() } },
      select: { copy: true },
    });
    const taskBack = await tx.task.findFirst({ where: { id: copy.taskId, userId }, select: { title: true } });
    let title = taskBack?.title;
    if (!taskBack) {
      if (!taskRow) throw new TaskError("Its task was deleted forever, so this entry can't come back.");
      title = await restoreCopy(tx, userId, taskRow.copy);
    }
    const result = await restoreTicksFromBin(tx, userId, [id]);
    if (result.restored !== 1 && result.alreadyBack !== 1) throw new TaskError("Couldn't restore that entry.");
    return title ?? "Your task";
  });
}

// Restore all: puts every task in the bin back. One at a time, each in its
// own transaction, so a long list never runs into the database's time limit
// for one transaction, and one that can't come back doesn't stop the rest.
// Returns how many came back and how many didn't.
export async function restoreAllFromBin(): Promise<{ restored: number; failed: number }> {
  const items = await listRecentlyDeleted();
  let restored = 0;
  let failed = 0;
  // Whole tasks first, so an entry whose task was deleted too finds it back.
  const tasksFirst = [...items.filter((i) => i.kind === "task"), ...items.filter((i) => i.kind === "tick")];
  for (const item of tasksFirst) {
    try {
      const result = await restoreFromBin(item.id);
      if ("restored" in result) restored++;
      else failed++;
    } catch (error) {
      if (!(error instanceof TaskError)) console.error("Restoring one item failed", error);
      failed++;
    }
  }
  return { restored, failed };
}

// Delete forever: removes one copy from the bin for good.
export async function deleteFromBin(id: string): Promise<void> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!isUuid(id)) throw new TaskError(NOT_IN_BIN);
  const { count } = await asCurrentUser((tx, userId) => tx.recentlyDeleted.deleteMany({ where: { id, userId } }));
  if (count === 0) throw new TaskError(NOT_IN_BIN);
}

// Empty bin: removes every copy in your bin for good. Returns how many.
export async function emptyBin(): Promise<number> {
  const { count } = await asCurrentUser((tx, userId) => tx.recentlyDeleted.deleteMany({ where: { userId } }));
  return count;
}

const NOT_IN_BIN = "That's no longer in Recently deleted.";

// Puts a deleted task back from its copy. The copy comes back from the
// browser, so every field is checked again like any other input.
export async function restoreDeletedTask(input: unknown): Promise<void> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  await asCurrentUser((tx, userId) => restoreCopy(tx, userId, input));
}

// Puts a task back from a copy (from swipe Undo, or Restore in Recently
// deleted) and takes it out of the bin. Returns its title.
async function restoreCopy(tx: Db, userId: string, input: unknown): Promise<string> {
  const { task, category, steps, ticks } = cleanCopy(input);
  if (await tx.task.findFirst({ where: { id: task.id }, select: { id: true } })) {
    throw new TaskError("It's already back.");
  }
  await tx.task.create({
    data: {
      ...task,
      userId,
      categoryId: await categoryIdFor(tx, userId, category),
      subtasks: { create: steps },
      completions: { create: ticks },
    },
  });
  // It's back, so it's no longer in Recently deleted.
  await tx.recentlyDeleted.deleteMany({ where: { id: task.id, userId } });
  return task.title;
}

// A deleted task's copy, every field checked, ready to save again. (A copy
// can come back from the browser, so it's treated like any other input.)
// Throws "That can't be undone." if it isn't a usable copy.
function cleanCopy(input: unknown) {
  const copy = asObject(input);
  const id = copy.id;
  if (!isUuid(id)) throw new TaskError("That can't be undone.");
  const dueDate = cleanDate(copy.dueDate);
  const done = copy.done === true;
  const steps = Array.isArray(copy.steps) ? copy.steps.map(asObject) : [];
  if (steps.length > MAX_STEPS) throw new TaskError("That can't be undone.");
  const ticks = Array.isArray(copy.ticks) ? copy.ticks.map(asObject) : [];
  if (ticks.length > 5000) throw new TaskError("That can't be undone.");
  return {
    task: {
      id,
      title: cleanTitle(copy.title),
      notes: cleanNotes(copy.notes),
      priority: cleanPriority(copy.priority) ?? "medium",
      dueDate: dueDate ? dateToDb(dueDate) : null,
      dueTime: dueDate ? cleanTime(copy.dueTime) : null,
      repeat: cleanRepeat(copy.repeat),
      done,
      doneAt: done ? cleanMoment(copy.doneAt) : null,
      createdAt: cleanMoment(copy.createdAt) ?? new Date(),
    },
    category: typeof copy.category === "string" ? copy.category : null,
    steps: steps.map((s, i) => ({
      ...(isUuid(s.id) ? { id: s.id } : {}),
      title: cleanStepTitle(s.title),
      done: s.done === true,
      position: Number.isInteger(s.position) ? (s.position as number) : i,
      createdAt: cleanMoment(s.createdAt) ?? new Date(),
    })),
    ticks: ticks.map(cleanTickFields),
  };
}

// What Undo after a batch delete did.
export type BatchRestoreResult = {
  restored: number; // tasks and entries put back
  alreadyBack: number; // already restored some other way (e.g. from Settings)
  failed: number; // couldn't come back (e.g. deleted forever from Settings meanwhile)
};

// Undo for a batch delete (deleteManyWithCopies): puts the whole tasks back
// from Recently deleted, and the single entries from their copies. All in one
// transaction, with a fixed number of queries however many there are (so 200
// are as quick as 2). Rows already back are skipped and counted; the rest
// still come back. `input` comes from the browser ({ taskIds, ticks }), so
// everything is checked here, and only this user's own copies can be used.
export async function restoreBatch(input: unknown): Promise<BatchRestoreResult> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  const { taskIds, ticks } = asObject(input);
  if (!Array.isArray(taskIds) || !Array.isArray(ticks)) throw new TaskError("That can't be undone.");
  if (taskIds.length + ticks.length === 0) throw new TaskError("That can't be undone.");
  if (taskIds.length > MAX_BATCH_DELETE || ticks.length > MAX_BATCH_DELETE) {
    throw new TaskError("That can't be undone.");
  }
  const ids = [...new Set(taskIds.filter(isUuid))];
  if (ids.length !== new Set(taskIds).size) throw new TaskError("That can't be undone.");

  return asCurrentUser(async (tx, userId) => {
    let restored = 0;
    let alreadyBack = 0;
    let failed = 0;

    // ── Whole tasks, from Recently deleted ──
    const binRows = await tx.recentlyDeleted.findMany({
      where: { id: { in: ids }, userId, deletedAt: { gte: binCutoff() } },
      select: { id: true, copy: true },
    });
    const existing = new Set(
      (await tx.task.findMany({ where: { id: { in: ids }, userId }, select: { id: true } })).map((t) => t.id),
    );
    const inBin = new Set(binRows.map((r) => r.id));
    for (const id of ids) {
      if (existing.has(id)) alreadyBack++; // e.g. restored from Settings meanwhile
      else if (!inBin.has(id)) failed++; // e.g. deleted forever from Settings meanwhile
    }
    const copies: ReturnType<typeof cleanCopy>[] = [];
    for (const row of binRows) {
      if (existing.has(row.id)) continue;
      try {
        copies.push(cleanCopy(row.copy));
      } catch {
        failed++;
      }
    }

    if (copies.length > 0) {
      // Categories by name, reusing existing ones whatever their capitals.
      const known = async () => tx.category.findMany({ where: { userId }, select: { id: true, name: true } });
      let categories = await known();
      const idFor = (name: string) => categories.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id;
      const names = [
        ...new Set(copies.map((c) => c.category?.trim().replace(/\s+/g, " ")).filter((n): n is string => !!n)),
      ].filter((n) => n.length <= MAX_CATEGORY);
      const missing = names.filter((n) => !idFor(n));
      if (missing.length > 0) {
        await tx.category.createMany({ data: missing.map((name) => ({ userId, name })), skipDuplicates: true });
        categories = await known();
      }
      const categoryOf = (c: ReturnType<typeof cleanCopy>) => {
        const name = c.category?.trim().replace(/\s+/g, " ");
        return name ? (idFor(name) ?? null) : null;
      };

      await tx.task.createMany({ data: copies.map((c) => ({ ...c.task, userId, categoryId: categoryOf(c) })) });
      await tx.subtask.createMany({ data: copies.flatMap((c) => c.steps.map((s) => ({ ...s, taskId: c.task.id }))) });
      await tx.taskCompletion.createMany({
        data: copies.flatMap((c) => c.ticks.map((t) => ({ ...t, taskId: c.task.id }))),
      });
      // They're back, so they're no longer in Recently deleted.
      await tx.recentlyDeleted.deleteMany({ where: { id: { in: copies.map((c) => c.task.id) }, userId } });
      restored += copies.length;
    }

    // ── Single entries ("Finished today"), from their copies in Recently
    // deleted (only their ids are taken from the browser) ──
    const tickIds = [...new Set(ticks.map((t) => asObject(t).id))];
    if (!tickIds.every(isUuid)) throw new TaskError("That can't be undone.");
    const entries = await restoreTicksFromBin(tx, userId, tickIds as string[]);
    restored += entries.restored;
    alreadyBack += entries.alreadyBack;
    failed += entries.failed + entries.needTask.length; // can't happen here: their tasks weren't deleted

    return { restored, alreadyBack, failed };
  });
}

// Deletes one tick of a repeating task (one history entry). The task itself
// stays exactly as it is, next date included. Returns a copy for Undo.
export async function deleteTickWithCopy(completionId: string): Promise<DeletedTick> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!isUuid(completionId)) throw new TaskError("That entry doesn't exist.");
  return asCurrentUser(async (tx, userId) => {
    const tick = await tx.taskCompletion.findFirst({
      where: { id: completionId, task: { userId } },
      include: { task: { select: { title: true } } },
    });
    if (!tick) throw new TaskError("That entry doesn't exist.");
    const { count } = await tx.taskCompletion.deleteMany({ where: { id: tick.id, task: { userId } } });
    if (count === 0) throw new TaskError("That entry doesn't exist.");
    // Kept in Recently deleted too, like a whole task (same transaction).
    await clearOldFromBin(tx, userId);
    await binCopies(tx, userId, [tickBinCopy(tick, tick.task.title)]);
    return tickCopy(tick);
  });
}

// ─── Entries in Recently deleted ─────────────────────────────────────────────
// A deleted entry (one tick of a repeating task) is kept in Recently deleted
// like a whole task: its copy is marked kind "tick", with the task's title
// (as it was then) for the list, which shows "Brush teeth · ticked Mon, Nov 24".
// Restoring one only puts the tick back in the task's history: it NEVER
// changes the task's date (deleting it didn't either). The task's newest tick
// is still the only one that can be un-ticked.

export type DeletedTickInBin = DeletedTick & { kind: "tick"; title: string };

function tickBinCopy(tick: Parameters<typeof tickCopy>[0], title: string): DeletedTickInBin {
  return { ...tickCopy(tick), kind: "tick", title };
}

// Puts copies (tasks or entries, each with an `id`) into Recently deleted in
// one statement, replacing any older copy with the same id. The caller clears
// out old copies first (clearOldFromBin) and runs this in the same
// transaction as the delete, so nothing is ever gone without its copy.
async function binCopies(tx: Db, userId: string, copies: { id: string }[]): Promise<void> {
  if (copies.length === 0) return;
  await tx.recentlyDeleted.deleteMany({ where: { id: { in: copies.map((c) => c.id) }, userId } });
  await tx.$executeRaw`
    INSERT INTO "RecentlyDeleted" ("id", "userId", "copy")
    SELECT (e->>'id')::uuid, ${userId}::uuid, e
    FROM jsonb_array_elements(${JSON.stringify(copies)}::jsonb) AS e`;
}

// Puts entries back from their copies in Recently deleted, in the caller's
// transaction, with a fixed number of queries however many there are. An
// entry already back counts as alreadyBack; one whose copy is gone (deleted
// forever) counts as failed; one whose task is in Recently deleted is listed
// in needTask (restore the task first); one whose task is gone for good is
// failed. Never changes any task's date.
async function restoreTicksFromBin(tx: Db, userId: string, ids: string[]) {
  const result = { restored: 0, alreadyBack: 0, failed: 0, needTask: [] as string[] };
  if (ids.length === 0) return result;
  const back = new Set(
    (await tx.taskCompletion.findMany({ where: { id: { in: ids }, task: { userId } }, select: { id: true } })).map(
      (t) => t.id,
    ),
  );
  const rows = await tx.recentlyDeleted.findMany({
    where: { id: { in: ids }, userId, deletedAt: { gte: binCutoff() } },
    select: { id: true, copy: true },
  });
  const inBin = new Map(rows.map((r) => [r.id, asObject(r.copy)]));
  const ready: (ReturnType<typeof cleanTickFields> & { id: string; taskId: string })[] = [];
  for (const id of ids) {
    const copy = inBin.get(id);
    if (back.has(id)) result.alreadyBack++;
    else if (!copy || copy.kind !== "tick" || !isUuid(copy.taskId)) result.failed++;
    else {
      try {
        ready.push({ ...cleanTickFields(copy), id, taskId: copy.taskId });
      } catch {
        result.failed++;
      }
    }
  }
  if (ready.length === 0) return result;

  const taskIds = [...new Set(ready.map((t) => t.taskId))];
  const ownTasks = new Set(
    (await tx.task.findMany({ where: { id: { in: taskIds }, userId }, select: { id: true } })).map((t) => t.id),
  );
  const tasksInBin = new Set(
    (
      await tx.recentlyDeleted.findMany({
        where: { id: { in: taskIds }, userId, deletedAt: { gte: binCutoff() } },
        select: { id: true },
      })
    ).map((t) => t.id),
  );
  const toCreate = ready.filter((t) => ownTasks.has(t.taskId));
  for (const t of ready) {
    if (ownTasks.has(t.taskId)) continue;
    if (tasksInBin.has(t.taskId)) result.needTask.push(t.id);
    else result.failed++; // its task was deleted forever
  }
  if (toCreate.length > 0) {
    await tx.taskCompletion.createMany({ data: toCreate, skipDuplicates: true });
    await tx.recentlyDeleted.deleteMany({ where: { id: { in: toCreate.map((t) => t.id) }, userId } });
    result.restored = toCreate.length;
  }
  return result;
}

// Puts a deleted tick back from its copy (checked again, like any input).
export async function restoreDeletedTick(input: unknown): Promise<void> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  const copy = asObject(input);
  const fields = cleanTickFields(copy);
  await asCurrentUser(async (tx, userId) => {
    const task = await findOwnedTask(tx, userId, copy.taskId as string);
    if (fields.id && (await tx.taskCompletion.findFirst({ where: { id: fields.id }, select: { id: true } }))) {
      throw new TaskError("It's already back.");
    }
    await tx.taskCompletion.create({ data: { ...fields, taskId: task.id } });
    // It's back, so it's no longer in Recently deleted.
    if (fields.id) await tx.recentlyDeleted.deleteMany({ where: { id: fields.id, userId } });
  });
}

function tickCopy(tick: {
  id: string;
  taskId: string;
  completedOn: Date;
  previousDueDate: Date | null;
  stepsDone: string[];
  createdAt: Date;
}): DeletedTick {
  return {
    id: tick.id,
    taskId: tick.taskId,
    completedOn: dateFromDb(tick.completedOn),
    previousDueDate: tick.previousDueDate ? dateFromDb(tick.previousDueDate) : null,
    stepsDone: tick.stepsDone,
    createdAt: tick.createdAt.toISOString(),
  };
}

// A tick's fields from a copy sent back by the browser, checked.
function cleanTickFields(value: Record<string, unknown>) {
  const completedOn = cleanDate(value.completedOn);
  if (!completedOn) throw new TaskError("That can't be undone.");
  const previousDueDate = cleanDate(value.previousDueDate);
  const stepsDone = Array.isArray(value.stepsDone) ? value.stepsDone.filter(isUuid).slice(0, MAX_STEPS) : [];
  return {
    ...(isUuid(value.id) ? { id: value.id } : {}),
    completedOn: dateToDb(completedOn),
    previousDueDate: previousDueDate ? dateToDb(previousDueDate) : null,
    stepsDone,
    createdAt: cleanMoment(value.createdAt) ?? new Date(),
  };
}

// An ISO timestamp from a copy, or null if it isn't one.
function cleanMoment(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asObject(value: unknown): Record<string, unknown> {
  return (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
}

// ─── Steps ───────────────────────────────────────────────────────────────────
// A step belongs to a task, so "is this yours?" is checked through its task.

// Adds a step to the end of a task's checklist.
export async function addStep(taskId: string, title: string): Promise<StepDTO> {
  const [step] = await addSteps(taskId, [title]);
  return step;
}

// Adds several steps to the end of a task's checklist, in order, all or none
// (used by Claude's "Suggest steps").
export async function addSteps(taskId: string, titles: string[]): Promise<StepDTO[]> {
  return asCurrentUser(async (tx, userId) => {
    const task = await findOwnedTask(tx, userId, taskId);
    if (!Array.isArray(titles) || titles.length === 0) throw new TaskError("Give the step a name.");
    const clean = titles.map(cleanStepTitle);

    const { _count, _max } = await tx.subtask.aggregate({
      where: { taskId: task.id },
      _count: true,
      _max: { position: true },
    });
    if (_count + clean.length > MAX_STEPS) throw new TaskError(`A task can have up to ${MAX_STEPS} steps.`);

    const start = (_max.position ?? -1) + 1;
    const steps: StepDTO[] = [];
    for (const [i, title] of clean.entries()) {
      steps.push(
        await tx.subtask.create({
          data: { taskId: task.id, title, position: start + i },
          select: { id: true, title: true, done: true },
        }),
      );
    }
    return steps;
  });
}

export async function setStepDone(stepId: string, done: boolean): Promise<void> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!isUuid(stepId)) throw new TaskError("That step doesn't exist.");
  // updateMany lets us filter by the task's owner too; it changes 0 rows if
  // the step isn't yours.
  const { count } = await asCurrentUser((tx, userId) =>
    tx.subtask.updateMany({
      where: { id: stepId, task: { userId } },
      data: { done },
    }),
  );
  if (count === 0) throw new TaskError("That step doesn't exist.");
}

export async function deleteStep(stepId: string): Promise<void> {
  await getCurrentUser(); // signed-out visitors are turned away before anything else
  if (!isUuid(stepId)) throw new TaskError("That step doesn't exist.");
  const { count } = await asCurrentUser((tx, userId) =>
    tx.subtask.deleteMany({ where: { id: stepId, task: { userId } } }),
  );
  if (count === 0) throw new TaskError("That step doesn't exist.");
}

// ─── Helpers (private to this file) ──────────────────────────────────────────

// The way every function in this file reaches the database: checks who's
// signed in (signed-out visitors are sent to /login), then runs `work` in one
// transaction as that user, so the database's row level security rules apply.
//
// Anything that reads the current time (Date.now(), new Date(), nowIn) must run
// AFTER the login check — inside `work`, or after an `await getCurrentUser()`.
// The login check is what tells Next.js the page depends on the live request;
// reading the clock before it makes Next.js stop with a "Blocking Route" error.
async function asCurrentUser<T>(work: (tx: Db, userId: string) => Promise<T>): Promise<T> {
  const user = await getCurrentUser();
  return runAsUser(user.id, (tx) => work(tx, user.id));
}

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
async function findOwnedTask(tx: Db, userId: string, id: string) {
  if (!isUuid(id)) throw new TaskError("That task doesn't exist.");
  const row = await tx.task.findFirst({
    where: { id, userId },
    select: { id: true, dueDate: true, dueTime: true, repeat: true, done: true },
  });
  if (!row) throw new TaskError("That task doesn't exist.");
  return { ...row, dueDate: row.dueDate ? dateFromDb(row.dueDate) : null };
}

// Records one tick of a repeating task, moves it to its next date and
// unticks its steps. It runs inside the caller's transaction, so it all
// happens together or not at all.
async function completeRepeatingTask(
  tx: Db,
  userId: string,
  task: { id: string; dueDate: string | null; repeat: Repeat },
  today: string, // in the user's own time zone
): Promise<DoneResult> {
  const nextDate = nextRepeatDate(task.repeat, task.dueDate, today);

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

  return { rolled: true, completionId: completion.id, nextDate, today };
}

// Turns a typed category name into its id, creating the category the first
// time it's used. Blank means "no category".
async function categoryIdFor(tx: Db, userId: string, name: string | null | undefined): Promise<string | null> {
  const clean = (name ?? "").trim().replace(/\s+/g, " ");
  if (!clean) return null;
  if (clean.length > MAX_CATEGORY) throw new TaskError(`Category names can be up to ${MAX_CATEGORY} characters.`);

  // Reuse an existing category even if the capitals differ ("fitness" → "Fitness").
  const existing = await tx.category.findFirst({
    where: { userId, name: { equals: clean, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) return existing.id;

  // upsert (not create) so two saves at the same moment can't make duplicates.
  const created = await tx.category.upsert({
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
