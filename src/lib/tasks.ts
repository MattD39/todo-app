import "server-only";
import { getCurrentUser } from "./auth";
import { db } from "./db";
import { Prisma } from "@/generated/prisma/client";
import type { Priority, Repeat } from "@/generated/prisma/enums";

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
};

export type CategoryDTO = { id: string; name: string };

// The fields someone can fill in when adding a task.
export type NewTaskInput = {
  title: string;
  notes?: string;
  priority?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  category?: string | null; // a name, e.g. "Fitness" — created if it's new
};

// When editing, every field is optional: only the ones you pass change.
export type TaskChanges = Partial<NewTaskInput>;

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
    include: { category: true },
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
    include: { category: true },
    orderBy: { doneAt: { sort: "desc", nulls: "last" } },
    take: limit,
  });
  return rows.map(toDTO);
}

// Tasks finished in the last 36 hours. The Today screen picks out the ones
// finished "today" in the user's own time zone (36h covers every time zone).
export async function listRecentlyDoneTasks(): Promise<TaskDTO[]> {
  const user = await getCurrentUser();
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000);
  const rows = await db.task.findMany({
    where: { userId: user.id, done: true, doneAt: { gte: since } },
    include: { category: true },
    orderBy: { doneAt: "desc" },
  });
  return rows.map(toDTO);
}

export async function getTask(id: string): Promise<TaskDTO | null> {
  const user = await getCurrentUser();
  if (!isUuid(id)) return null;
  const row = await db.task.findFirst({
    where: { id, userId: user.id },
    include: { category: true },
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
      categoryId,
    },
    include: { category: true },
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
    include: { category: true },
  });
  return toDTO(row);
}

// Tick a task off, or untick it. (Repeating tasks roll forward to their next
// date instead — that arrives in Phase 4.)
export async function setTaskDone(id: string, done: boolean): Promise<TaskDTO> {
  const user = await getCurrentUser();
  const current = await findOwnedTask(user.id, id);
  const row = await db.task.update({
    where: { id: current.id, userId: user.id },
    data: { done, doneAt: done ? new Date() : null },
    include: { category: true },
  });
  return toDTO(row);
}

export async function deleteTask(id: string): Promise<void> {
  const user = await getCurrentUser();
  if (!isUuid(id)) throw new TaskError("That task doesn't exist.");
  // deleteMany lets us filter by userId too; it deletes 0 rows if the task
  // isn't yours. Its subtasks and history are removed with it (cascade).
  const { count } = await db.task.deleteMany({ where: { id, userId: user.id } });
  if (count === 0) throw new TaskError("That task doesn't exist.");
}

// ─── Helpers (private to this file) ──────────────────────────────────────────

type TaskRow = Prisma.TaskGetPayload<{ include: { category: true } }>;

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
  };
}

// Loads a task only if it belongs to this user; otherwise acts as if it
// doesn't exist (so nobody can learn which ids are real).
async function findOwnedTask(userId: string, id: string) {
  if (!isUuid(id)) throw new TaskError("That task doesn't exist.");
  const row = await db.task.findFirst({
    where: { id, userId },
    select: { id: true, dueDate: true, dueTime: true },
  });
  if (!row) throw new TaskError("That task doesn't exist.");
  return { id: row.id, dueDate: row.dueDate ? dateFromDb(row.dueDate) : null, dueTime: row.dueTime };
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
