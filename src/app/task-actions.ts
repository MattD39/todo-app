"use server";

import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { relDay } from "@/lib/dates";
import {
  addStep,
  addSteps,
  createTask,
  deleteStep,
  deleteTask,
  setStepDone,
  setTaskDone,
  TaskError,
  undoCompletion,
  updateTask,
  type NewTaskInput,
  type StepDTO,
} from "@/lib/tasks";

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
  const { error } = await run("save", () => createTask({ ...fields, steps }));
  return { error, savedAt: error ? null : Date.now() };
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
  return run("delete", () => deleteTask(id));
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
