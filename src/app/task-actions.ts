"use server";

import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { createTask, deleteTask, setTaskDone, TaskError, updateTask } from "@/lib/tasks";

// Server actions: functions the browser can call. Anyone could call these
// directly, so they never trust the input — they hand it to src/lib/tasks.ts,
// which checks who's signed in, checks every field, and only touches that
// person's tasks.

export type ActionResult = { error: string | null };
export type SaveTaskState = { error: string | null; savedAt: number | null };

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
  };

  const id = text("id");
  const { error } = await run("save", () => (id ? updateTask(id, fields) : createTask(fields)));
  return { error, savedAt: error ? null : Date.now() };
}

// Tick a task off (done = true) or untick it (done = false).
export async function markTaskDone(id: unknown, done: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || typeof done !== "boolean") return { error: "Something went wrong." };
  return run("update", () => setTaskDone(id, done));
}

export async function removeTask(id: unknown): Promise<ActionResult> {
  if (typeof id !== "string") return { error: "Something went wrong." };
  return run("delete", () => deleteTask(id));
}

// Shared by every action: do the change, turn problems into a friendly
// message, and refresh the page so it shows the latest data.
async function run(verb: string, change: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await change();
  } catch (error) {
    // If the login has expired, getCurrentUser() "throws" a redirect to /login.
    // That isn't a real error, so let Next.js carry it out.
    unstable_rethrow(error);
    if (error instanceof TaskError) return { error: error.message };
    console.error(`Task ${verb} failed`, error);
    return { error: `Couldn't ${verb}. Check your connection and try again.` };
  }
  refresh();
  return { error: null };
}
