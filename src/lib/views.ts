import type { HistoryDTO, TaskDTO, TickDTO } from "./tasks";
import { addDays, addMonths, dayOf, isOverdue, type Now } from "./dates";

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
export function inCategory<T extends TaskDTO>(tasks: T[], category: string | null): T[] {
  return category ? tasks.filter((t) => t.category?.name === category) : tasks;
}

// The dots on the Calendar: how many unfinished tasks fall on each day,
// whether any of them is overdue (red dots), and how many later repeats of
// weekly/monthly tasks land there (faint dots). Days with nothing aren't listed.
export type DayMark = { count: number; overdue: boolean; repeats: number };

export function calendarMarks(
  open: TaskDTO[],
  repeats: Record<string, string[]>, // from futureRepeats
  now: Now,
): Record<string, DayMark> {
  const marks: Record<string, DayMark> = {};
  const markFor = (day: string) => (marks[day] ??= { count: 0, overdue: false, repeats: 0 });
  for (const task of open) {
    if (!task.dueDate) continue;
    const mark = markFor(task.dueDate);
    mark.count++;
    if (isOverdue(task, now)) mark.overdue = true;
  }
  for (const [day, ids] of Object.entries(repeats)) markFor(day).repeats = ids.length;
  return marks;
}

// Where weekly and monthly tasks will land after their next due date, for
// planning: day → ids of the tasks repeating that day, for days from `from`
// to `to`. Only days after today count (an overdue task's missed weeks
// aren't shown). Daily tasks are left out — a dot on every day is just noise.
// Uses the same steps as ticking a task off (nextRepeatDate), so the dates match.
export function futureRepeats(open: TaskDTO[], from: string, to: string, today: string): Record<string, string[]> {
  const byDay: Record<string, string[]> = {};
  for (const task of open) {
    if (!task.dueDate || (task.repeat !== "weekly" && task.repeat !== "monthly")) continue;
    const base = task.dueDate;
    const step = (i: number) => (task.repeat === "weekly" ? addDays(base, 7 * i) : addMonths(base, i));
    for (let i = 1, day = step(1); day <= to; day = step(++i)) {
      if (day >= from && day > today) (byDay[day] ??= []).push(task.id);
    }
  }
  return byDay;
}

// One day's history on the Calendar.
//   finished: one-off tasks finished that day, plus repeating-task ticks done
//             that day — most recent first.
//   movedOn:  repeating tasks that were due that day but ticked on another
//             day ("Done early on Tue, Nov 17"), so they don't seem to vanish.
export function dayHistory(
  history: HistoryDTO,
  day: string,
  timeZone: string,
): { finished: TaskDTO[]; movedOn: TickDTO[] } {
  const finished = [
    ...history.done.filter((t) => t.doneAt && dayOf(t.doneAt, timeZone) === day),
    ...history.ticks.filter((t) => t.completedOn === day),
  ].sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  const movedOn = history.ticks.filter((t) => t.previousDueDate === day && t.completedOn !== day);
  return { finished, movedOn };
}
