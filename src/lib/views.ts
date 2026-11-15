import type { TaskDTO } from "./tasks";
import { dayOf, isOverdue, type Now } from "./dates";

// Sorting tasks into the sections each screen shows. Pure functions (no
// database, no clock of their own) so they're easy to test.

export type TodayView = {
  overdue: TaskDTO[];
  dueToday: TaskDTO[];
  anytime: TaskDTO[];
  finishedToday: TaskDTO[];
};

// open: unfinished tasks, already in display order (soonest first).
// recentlyDone: tasks finished in roughly the last day and a half.
export function buildToday(open: TaskDTO[], recentlyDone: TaskDTO[], now: Now, timeZone: string): TodayView {
  const overdue: TaskDTO[] = [];
  const dueToday: TaskDTO[] = [];
  const anytime: TaskDTO[] = [];
  for (const task of open) {
    if (isOverdue(task, now)) overdue.push(task);
    else if (task.dueDate === now.today) dueToday.push(task);
    else if (!task.dueDate) anytime.push(task);
    // Anything else is due later — it belongs on the Upcoming screen.
  }
  const finishedToday = recentlyDone.filter((t) => t.doneAt && dayOf(t.doneAt, timeZone) === now.today);
  return { overdue, dueToday, anytime, finishedToday };
}

// Tasks due after today, one group per day, soonest first.
export function buildUpcoming(open: TaskDTO[], now: Now): { day: string; tasks: TaskDTO[] }[] {
  const byDay = new Map<string, TaskDTO[]>();
  for (const task of open) {
    if (!task.dueDate || task.dueDate <= now.today) continue;
    const list = byDay.get(task.dueDate) ?? [];
    list.push(task);
    byDay.set(task.dueDate, list);
  }
  return [...byDay].map(([day, tasks]) => ({ day, tasks }));
}

// The summary line under each screen's title. Always counts every task,
// whatever category filter is on.
export type Stats = { dueToday: number; overdue: number; open: number };

export function buildStats(open: TaskDTO[], now: Now): Stats {
  return {
    dueToday: open.filter((t) => t.dueDate === now.today).length,
    overdue: open.filter((t) => isOverdue(t, now)).length,
    open: open.length,
  };
}

// Only the tasks in one category, or all of them when category is null.
export function inCategory(tasks: TaskDTO[], category: string | null): TaskDTO[] {
  return category ? tasks.filter((t) => t.category?.name === category) : tasks;
}
