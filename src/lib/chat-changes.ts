import "server-only";
import { unstable_rethrow } from "next/navigation";
import { formatDay, formatTime, isValidDay } from "./dates";
import {
  createTask,
  deleteTask,
  getTask,
  MAX_CATEGORY,
  saveCategory,
  MAX_NOTES,
  MAX_TITLE,
  setTaskDone,
  TaskError,
  undoCompletion,
  unsaveCategory,
  updateTask,
  type TaskChanges,
  type TaskDTO,
} from "./tasks";

// Changes Claude asks for in the Chat tab (add a task, change one, tick one
// off). Claude never touches the database: while it writes its reply, each
// change it asks for is only written down ("queued"). The queued changes are
// sent to the chat at the end of the reply, and the chat saves them all
// straight away (each shown with an Undo button), unless you pressed Stop.
// Saving happens in a separate request (applyChatChanges in
// src/app/chat-actions.ts) through src/lib/tasks.ts, so the same checks and
// the database's own rules (only your tasks) apply as when you tap buttons.
// There's no "delete" change on purpose.

// Most changes one message can queue, so one message can't rewrite the whole list.
export const MAX_CHANGES_PER_MESSAGE = 10;
// Work shifts from a schedule photo (add_shift) may go up to 20 in one message
// (two weeks, or double shifts); everything else still stops at 10.
export const MAX_SHIFTS_PER_MESSAGE = 20;
// So the most one message can ever save (and Undo) is:
export const MAX_SAVED_PER_MESSAGE = Math.max(MAX_CHANGES_PER_MESSAGE, MAX_SHIFTS_PER_MESSAGE);

export type ChatChange =
  | { kind: "add"; task: AddFields; summary: string; shift?: true } // shift: from a schedule photo (add_shift)
  | { kind: "update"; taskId: string; changes: TaskChanges; summary: string }
  | { kind: "complete"; taskId: string; summary: string }
  // Put a category on the saved list (save_category, step g4): only after the
  // user says yes to "Save it to your list?".
  | { kind: "save-category"; name: string; summary: string };

export type AddFields = {
  title: string;
  notes?: string;
  priority?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  category?: string | null;
  repeat?: string | null;
};

// How to put a change back the way it was (used by the Undo button).
export type ChangeUndo =
  | { kind: "remove-added"; taskId: string } // an added task: remove it again
  | { kind: "restore"; taskId: string; changes: TaskChanges } // a changed task: old values
  | { kind: "untick"; taskId: string } // a one-off task that was ticked off
  | { kind: "undo-tick"; completionId: string } // one round of a repeating task
  | { kind: "unsave-category"; name: string; remove: boolean }; // take it off the saved list again

export type ChangeResult =
  | { ok: true; summary: string; undo: ChangeUndo }
  | { ok: false; summary: string; error: string };

// ─── Short descriptions shown in the chat ────────────────────────────────────

export function describeAdd(task: AddFields): string {
  const due = task.dueDate ? ` – ${formatDay(task.dueDate)}${task.dueTime ? `, ${formatTime(task.dueTime)}` : ""}` : "";
  return `Add “${task.title}”${due}`;
}

export function describeUpdate(task: TaskDTO, changes: TaskChanges): string {
  const what: string[] = [];
  if (changes.title !== undefined) what.push(`rename to “${changes.title}”`);
  if (changes.dueDate !== undefined || changes.dueTime !== undefined) {
    const date = changes.dueDate !== undefined ? changes.dueDate : task.dueDate;
    const time = changes.dueTime !== undefined ? changes.dueTime : task.dueTime;
    what.push(date ? `due ${formatDay(date)}${time ? `, ${formatTime(time)}` : ""}` : "no due date");
  }
  if (changes.priority !== undefined) what.push(`${changes.priority} priority`);
  if (changes.category !== undefined) what.push(changes.category ? `category “${changes.category}”` : "no category");
  if (changes.repeat !== undefined) what.push(changes.repeat ? `repeats ${changes.repeat}` : "doesn't repeat");
  return `Change “${task.title}”: ${what.join(", ")}`;
}

export function describeSave(name: string): string {
  return `Save “${name}” to your categories`;
}

export function describeComplete(task: TaskDTO): string {
  return task.repeat ? `Tick off “${task.title}” (moves to its next date)` : `Tick off “${task.title}”`;
}

// The values a change is about to overwrite, so Undo can put them back.
function previousValues(task: TaskDTO, changes: TaskChanges): TaskChanges {
  const before: TaskChanges = {};
  if (changes.title !== undefined) before.title = task.title;
  if (changes.dueDate !== undefined || changes.dueTime !== undefined) {
    before.dueDate = task.dueDate;
    before.dueTime = task.dueTime;
  }
  if (changes.priority !== undefined) before.priority = task.priority;
  if (changes.category !== undefined) before.category = task.category?.name ?? null;
  if (changes.repeat !== undefined) before.repeat = task.repeat;
  return before;
}

// ─── Checking the field values (shared by Claude's tool calls and the browser) ─

// Turns raw field values into TaskChanges, or a short reason they're wrong.
// Only the fields present are included. (tasks.ts checks everything again.)
export function cleanFields(input: Record<string, unknown>): TaskChanges | string {
  const fields: TaskChanges = {};
  if (input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > MAX_TITLE) return `a title must be 1 to ${MAX_TITLE} characters.`;
    fields.title = title;
  }
  if (input.dueDate !== undefined) {
    if (input.dueDate !== null && !(typeof input.dueDate === "string" && isValidDay(input.dueDate))) {
      return 'the due date must be a real day as "YYYY-MM-DD", or null.';
    }
    fields.dueDate = input.dueDate as string | null;
  }
  if (input.dueTime !== undefined) {
    const ok = typeof input.dueTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.dueTime);
    if (input.dueTime !== null && !ok) return 'the due time must be 24-hour "HH:MM", or null.';
    fields.dueTime = input.dueTime as string | null;
  }
  if (input.priority !== undefined) {
    if (!["high", "medium", "low"].includes(input.priority as string)) return "priority must be high, medium or low.";
    fields.priority = input.priority as string;
  }
  if (input.category !== undefined) {
    const category = typeof input.category === "string" ? input.category.trim() : "";
    if (category.length > MAX_CATEGORY) return `a category name can be up to ${MAX_CATEGORY} characters.`;
    fields.category = category || null;
  }
  if (input.repeat !== undefined) {
    if (input.repeat !== null && !["daily", "weekly", "monthly"].includes(input.repeat as string)) {
      return "repeat must be daily, weekly, monthly or null.";
    }
    fields.repeat = input.repeat as string | null;
  }
  return fields;
}

// The changes sent back by the browser, checked again (anything typed in a
// browser can be faked). Returns null if anything is off.
export function cleanChanges(input: unknown): ChatChange[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_SAVED_PER_MESSAGE) return null;
  const changes: ChatChange[] = [];
  for (const item of input) {
    const value = asRecord(item);
    if (value.kind === "add") {
      const task = asRecord(value.task);
      const fields = cleanFields(task);
      if (typeof fields === "string" || !fields.title) return null;
      const notes = typeof task.notes === "string" ? task.notes.trim().slice(0, MAX_NOTES) : "";
      const add: AddFields = { ...fields, title: fields.title, ...(notes ? { notes } : {}) };
      changes.push({ kind: "add", task: add, summary: describeAdd(add) });
    } else if (value.kind === "update" && typeof value.taskId === "string") {
      const fields = cleanFields(asRecord(value.changes));
      if (typeof fields === "string" || Object.keys(fields).length === 0) return null;
      changes.push({ kind: "update", taskId: value.taskId, changes: fields, summary: "" });
    } else if (value.kind === "complete" && typeof value.taskId === "string") {
      changes.push({ kind: "complete", taskId: value.taskId, summary: "" });
    } else if (value.kind === "save-category") {
      const name = cleanCategory(value.name);
      if (!name) return null;
      changes.push({ kind: "save-category", name, summary: describeSave(name) });
    } else {
      return null;
    }
  }
  return changes;
}

// ─── Saving the changes ──────────────────────────────────────────────────────

// Saves each change in order. One failing doesn't stop the others; each
// result says how it went, with a description worked out here (not taken
// from the browser) and what Undo needs.
export async function applyChanges(changes: ChatChange[]): Promise<ChangeResult[]> {
  const results: ChangeResult[] = [];
  for (const change of changes.slice(0, MAX_SAVED_PER_MESSAGE)) {
    results.push(await applyOne(change));
  }
  return results;
}

async function applyOne(change: ChatChange): Promise<ChangeResult> {
  let summary =
    change.kind === "add" ? describeAdd(change.task) : change.kind === "save-category" ? change.summary : "Change a task";
  try {
    if (change.kind === "save-category") {
      const saved = await saveCategory(change.name);
      summary = describeSave(saved.name); // with its capitals as saved
      if (saved.alreadySaved) throw new TaskError("It's already on your list.");
      return { ok: true, summary, undo: { kind: "unsave-category", name: saved.name, remove: saved.created } };
    }
    if (change.kind === "add") {
      const task = await createTask(change.task);
      return { ok: true, summary, undo: { kind: "remove-added", taskId: task.id } };
    }

    // Read the task as it is right now, for the description and for Undo.
    const task = await getTask(change.taskId);
    if (!task || task.done) throw new TaskError("That task isn't on your open list any more.");

    if (change.kind === "update") {
      summary = describeUpdate(task, change.changes);
      await updateTask(task.id, change.changes);
      return { ok: true, summary, undo: { kind: "restore", taskId: task.id, changes: previousValues(task, change.changes) } };
    }

    summary = describeComplete(task);
    const result = await setTaskDone(task.id, true);
    const undo: ChangeUndo = result.rolled
      ? { kind: "undo-tick", completionId: result.completionId }
      : { kind: "untick", taskId: task.id };
    return { ok: true, summary, undo };
  } catch (error) {
    // An expired login "throws" a redirect to /login; let Next.js carry it out.
    unstable_rethrow(error);
    if (error instanceof TaskError) return { ok: false, summary, error: error.message };
    console.error("Chat change failed", error);
    return { ok: false, summary, error: "Something went wrong saving this change." };
  }
}

// ─── Undo ────────────────────────────────────────────────────────────────────

export type UndoResult = { ok: true } | { ok: false; error: string };

// The Undo details sent back by the browser, checked again. Null if anything is off.
export function cleanUndos(input: unknown): ChangeUndo[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_SAVED_PER_MESSAGE) return null;
  const undos: ChangeUndo[] = [];
  for (const item of input) {
    const value = asRecord(item);
    if (value.kind === "remove-added" && typeof value.taskId === "string") {
      undos.push({ kind: "remove-added", taskId: value.taskId });
    } else if (value.kind === "restore" && typeof value.taskId === "string") {
      const changes = cleanFields(asRecord(value.changes));
      if (typeof changes === "string" || Object.keys(changes).length === 0) return null;
      undos.push({ kind: "restore", taskId: value.taskId, changes });
    } else if (value.kind === "untick" && typeof value.taskId === "string") {
      undos.push({ kind: "untick", taskId: value.taskId });
    } else if (value.kind === "undo-tick" && typeof value.completionId === "string") {
      undos.push({ kind: "undo-tick", completionId: value.completionId });
    } else if (value.kind === "unsave-category") {
      const name = cleanCategory(value.name);
      if (!name) return null;
      undos.push({ kind: "unsave-category", name, remove: value.remove === true });
    } else {
      return null;
    }
  }
  return undos;
}

// Puts changes back, one by one, in the order given (Undo all sends the
// newest first, so a task added and then changed is changed back before it's
// removed). One failing doesn't stop the others. Goes through tasks.ts like
// everything else: only your own tasks.
export async function undoChanges(undos: ChangeUndo[]): Promise<UndoResult[]> {
  const results: UndoResult[] = [];
  for (const undo of undos) {
    try {
      if (undo.kind === "remove-added") await deleteTask(undo.taskId);
      else if (undo.kind === "restore") await updateTask(undo.taskId, undo.changes);
      else if (undo.kind === "untick") await setTaskDone(undo.taskId, false);
      else if (undo.kind === "unsave-category") await unsaveCategory(undo.name, undo.remove);
      else await undoCompletion(undo.completionId);
      results.push({ ok: true });
    } catch (error) {
      unstable_rethrow(error); // an expired login redirects to /login
      if (error instanceof TaskError) {
        results.push({ ok: false, error: error.message });
      } else {
        console.error("Chat undo failed", error);
        results.push({ ok: false, error: "Something went wrong undoing this." });
      }
    }
  }
  return results;
}

// A category name as sent: spaces tidied, 1 to MAX_CATEGORY characters, or null.
export function cleanCategory(input: unknown): string | null {
  const name = typeof input === "string" ? input.trim().replace(/\s+/g, " ") : "";
  return name && name.length <= MAX_CATEGORY ? name : null;
}

function asRecord(input: unknown): Record<string, unknown> {
  return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}
