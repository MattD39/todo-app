"use server";

import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { relDay } from "@/lib/dates";
import {
  addStep,
  addSteps,
  categoryUsage,
  deleteSavedCategory,
  listOneOffCategories,
  listSavedCategories,
  renameCategory,
  saveCategory,
  createTask,
  deleteStep,
  deleteFromBin,
  deleteManyWithCopies,
  deleteTaskWithCopy,
  deleteTickWithCopy,
  emptyBin,
  listRecentlyDeleted,
  restoreAllFromBin,
  restoreBatch,
  restoreEntryAndTask,
  restoreFromBin,
  restoreDeletedTask,
  restoreDeletedTick,
  setStepDone,
  setTaskDone,
  TaskError,
  undoCompletion,
  updateTask,
  type BatchDeleteResult,
  type BatchRestoreResult,
  type BinItem,
  type RestoreResult,
  type SavedCategory,
  type DeletedTask,
  type DeletedTick,
  type NewTaskInput,
  type StepDTO,
} from "@/lib/tasks";

// Server actions: functions the browser can call. Anyone could call these
// directly, so they never trust the input — they hand it to src/lib/tasks.ts,
// which checks who's signed in, checks every field, and only touches that
// person's tasks.

export type ActionResult = { error: string | null };
// added: set only when a NEW task was saved from the Add task sheet, so the
// screen can say where it went ("Added to Upcoming"). Edits leave it out.
export type AddedTask = { id: string; dueDate: string | null; category: string | null };
export type SaveTaskState = { error: string | null; savedAt: number | null; added?: AddedTask };

// Saves the task editor form. With an id it edits that task; without one it
// adds a new task.
export async function saveTask(_prev: SaveTaskState, formData: FormData): Promise<SaveTaskState> {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  const fields = {
    title: text("title"),
    category: text("category"),
    priority: text("priority"),
    dueDate: text("dueDate"),
    dueTime: text("dueTime"),
    notes: text("notes"),
    repeat: text("repeat"),
  };

  const id = text("id");
  if (id) {
    const { error } = await run("save", () => updateTask(id, fields));
    return { error, savedAt: error ? null : Date.now() };
  }

  // A new task's steps come as one JSON list: [{ "title": "...", "done": false }].
  // The shape isn't trusted: src/lib/tasks.ts checks every step.
  let steps: NewTaskInput["steps"];
  try {
    steps = JSON.parse(text("steps") || "[]");
  } catch {
    return { error: "Something went wrong with the steps.", savedAt: null };
  }
  const { error, value } = await run("save", () => createTask({ ...fields, steps }));
  if (error || !value) return { error, savedAt: null };
  return {
    error: null,
    savedAt: Date.now(),
    added: { id: value.id, dueDate: value.dueDate, category: value.category?.name ?? null },
  };
}

// Steps on a task that's already saved change straight away, one at a time.
export async function addTaskStep(taskId: unknown, title: unknown): Promise<ActionResult & { step?: StepDTO }> {
  if (typeof taskId !== "string" || typeof title !== "string") return { error: "Something went wrong." };
  const { error, value } = await run("add the step", () => addStep(taskId, title));
  return { error, step: value };
}

// Several steps at once (from Claude's "Suggest steps"), saved all or none.
export async function addTaskSteps(taskId: unknown, titles: unknown): Promise<ActionResult & { steps?: StepDTO[] }> {
  if (typeof taskId !== "string" || !Array.isArray(titles) || !titles.every((t) => typeof t === "string")) {
    return { error: "Something went wrong." };
  }
  const { error, value } = await run("add the steps", () => addSteps(taskId, titles));
  return { error, steps: value };
}

export async function tickTaskStep(stepId: unknown, done: unknown): Promise<ActionResult> {
  if (typeof stepId !== "string" || typeof done !== "boolean") return { error: "Something went wrong." };
  return run("update the step", () => setStepDone(stepId, done));
}

export async function removeTaskStep(stepId: unknown): Promise<ActionResult> {
  if (typeof stepId !== "string") return { error: "Something went wrong." };
  return run("remove the step", () => deleteStep(stepId));
}

// When a repeating task is ticked, the browser gets a message to show
// ("Done. Next one: Tomorrow") and the id it needs to undo the tick.
export type MarkDoneResult = ActionResult & { undo?: { completionId: string; message: string } };

// Tick a task off (done = true) or untick it (done = false).
export async function markTaskDone(id: unknown, done: unknown): Promise<MarkDoneResult> {
  if (typeof id !== "string" || typeof done !== "boolean") return { error: "Something went wrong." };
  const { error, value } = await run("update", () => setTaskDone(id, done));
  if (error || !value?.rolled) return { error };
  return {
    error: null,
    undo: { completionId: value.completionId, message: `Done. Next one: ${relDay(value.nextDate, value.today)}` },
  };
}

// Undo one tick of a repeating task (from the message's Undo button, or by
// unticking its row under "Finished today").
export async function undoTick(completionId: unknown): Promise<ActionResult> {
  if (typeof completionId !== "string") return { error: "Something went wrong." };
  return run("undo", () => undoCompletion(completionId));
}

export async function removeTask(id: unknown): Promise<ActionResult> {
  if (typeof id !== "string") return { error: "Something went wrong." };
  // Kept in Recently deleted, the same as swipe to delete (the copy it
  // returns isn't needed here: the editor has no Undo bar).
  return run("delete", async () => {
    await deleteTaskWithCopy(id);
  });
}

// Swipe to delete: a whole task, or one tick of a repeating task (one entry
// in its history). The result carries a copy for the "Deleted · Undo" bar.
export async function swipeDelete(
  target: unknown,
): Promise<ActionResult & { value?: { task: DeletedTask } | { tick: DeletedTick } }> {
  const { taskId, completionId } = (typeof target === "object" && target !== null ? target : {}) as Record<
    string,
    unknown
  >;
  if (typeof completionId === "string") {
    return run("delete", async () => ({ tick: await deleteTickWithCopy(completionId) }));
  }
  if (typeof taskId === "string") {
    return run("delete", async () => ({ task: await deleteTaskWithCopy(taskId) }));
  }
  return { error: "Something went wrong." };
}

// Edit mode: deletes the selected rows together (checked again in tasks.ts).
// Each whole task goes into Recently deleted, the same as swipe to delete.
// The result says how many were deleted or already gone.
export async function deleteSelected(targets: unknown): Promise<ActionResult & { value?: BatchDeleteResult }> {
  return run("delete", () => deleteManyWithCopies(targets));
}

// Undo for deleteSelected: puts the tasks back from Recently deleted and the
// single entries from their copies (all checked again in tasks.ts).
export async function undoDeleteSelected(deleted: unknown): Promise<ActionResult & { value?: BatchRestoreResult }> {
  return run("undo", () => restoreBatch(deleted));
}

// Undo for swipe to delete: puts the copy back (checked again in tasks.ts).
export async function undoSwipeDelete(copy: unknown): Promise<ActionResult> {
  const { task, tick } = (typeof copy === "object" && copy !== null ? copy : {}) as Record<string, unknown>;
  if (task) return run("undo", () => restoreDeletedTask(task));
  if (tick) return run("undo", () => restoreDeletedTick(tick));
  return { error: "That can't be undone." };
}

// ─── Categories (Settings) ───────────────────────────────────────────────────

export type CategoriesList = { saved: SavedCategory[]; oneOffs: { id: string; name: string; tasks: number }[] };

// The saved list and the one-offs in use, for Settings → Categories. Only
// reads, so the page isn't refreshed.
export async function getCategories(): Promise<{ error: string | null; value?: CategoriesList }> {
  try {
    const [saved, oneOffs] = await Promise.all([listSavedCategories(), listOneOffCategories()]);
    return { error: null, value: { saved, oneOffs } };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Listing categories failed", error);
    return { error: "Couldn't load your categories. Check your connection and try again." };
  }
}

// Add a category to the saved list, or save a one-off (same thing: by name).
export async function addCategory(name: unknown): Promise<ActionResult & { value?: { name: string; alreadySaved: boolean } }> {
  return run("save the category", () => saveCategory(name));
}

export async function renameSavedCategory(id: unknown, name: unknown): Promise<ActionResult & { value?: string }> {
  return run("rename the category", () => renameCategory(id, name));
}

// How many tasks would lose it, for the "Delete Work?" box. Only reads.
export async function getCategoryUsage(
  id: unknown,
): Promise<{ error: string | null; value?: { name: string; tasks: number; finished: number } }> {
  try {
    return { error: null, value: await categoryUsage(id) };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TaskError) return { error: error.message };
    console.error("Counting a category's tasks failed", error);
    return { error: "Couldn't check that category. Check your connection and try again." };
  }
}

// Deleting is only possible here, in Settings. Its tasks keep going with no
// category. The result is how many tasks lost it.
export async function deleteCategory(id: unknown): Promise<ActionResult & { value?: number }> {
  return run("delete the category", () => deleteSavedCategory(id));
}

// ─── Recently deleted (Settings) ─────────────────────────────────────────────

// The list for the Settings sheet. Only reads, so the page isn't refreshed.
export async function getRecentlyDeleted(): Promise<{ error: string | null; items?: BinItem[] }> {
  try {
    return { error: null, items: await listRecentlyDeleted() };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Listing recently deleted failed", error);
    return { error: "Couldn't load Recently deleted. Check your connection and try again." };
  }
}

// Restore one item: a task, or one entry of a repeating task. For an entry
// whose task is also in Recently deleted, value says so (needsTask) and
// nothing changes, so the screen can offer "Restore both".
export async function restoreTask(id: unknown): Promise<ActionResult & { value?: RestoreResult }> {
  if (typeof id !== "string") return { error: "Something went wrong." };
  return run("restore", () => restoreFromBin(id));
}

// "Restore both": an entry and its task, together.
export async function restoreEntryWithTask(id: unknown): Promise<ActionResult & { value?: string }> {
  if (typeof id !== "string") return { error: "Something went wrong." };
  return run("restore", () => restoreEntryAndTask(id));
}

export async function restoreAll(): Promise<ActionResult & { value?: { restored: number; failed: number } }> {
  return run("restore", () => restoreAllFromBin());
}

export async function deleteForever(id: unknown): Promise<ActionResult> {
  if (typeof id !== "string") return { error: "Something went wrong." };
  return run("delete", () => deleteFromBin(id));
}

export async function emptyRecentlyDeleted(): Promise<ActionResult> {
  return run("empty Recently deleted", async () => {
    await emptyBin();
  });
}

// Shared by every action: do the change, turn problems into a friendly
// message, and refresh the page so it shows the latest data.
async function run<T>(verb: string, change: () => Promise<T>): Promise<ActionResult & { value?: T }> {
  let value: T;
  try {
    value = await change();
  } catch (error) {
    // If the login has expired, getCurrentUser() "throws" a redirect to /login.
    // That isn't a real error, so let Next.js carry it out.
    unstable_rethrow(error);
    if (error instanceof TaskError) return { error: error.message };
    console.error(`Task ${verb} failed`, error);
    return { error: `Couldn't ${verb}. Check your connection and try again.` };
  }
  refresh();
  return { error: null, value };
}
