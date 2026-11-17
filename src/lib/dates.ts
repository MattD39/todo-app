// Date helpers used by both the server and the browser.
//
// A "day" is a string like "2026-11-15" and a "time" is "HH:MM" (24-hour).
// Plain strings compare correctly ("2026-11-14" < "2026-11-15"), so most
// checks below are simple string comparisons.
//
// "What day is it?" depends on where you are, so anything about *now* takes
// the user's time zone (e.g. "America/Toronto"). The server's own clock is UTC.

export type Now = { today: string; time: string };

// The current day and time in the given time zone.
export function nowIn(timeZone: string, at: Date = new Date()): Now {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return { today: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

// Which day (in the user's time zone) a moment like doneAt fell on.
export function dayOf(isoTimestamp: string, timeZone: string): string {
  return nowIn(timeZone, new Date(isoTimestamp)).today;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Same day of the month, n months later. If that month is shorter, it uses
// the month's last day instead (Jan 31 + 1 month = Feb 28, or 29 in a leap year).
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}

// True for a real calendar day written as "YYYY-MM-DD" (rejects "2026-02-30").
export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

// The days a month calendar shows, Sunday first: starts on the Sunday on or
// before the 1st and fills whole weeks — 5 rows usually, 6 when the month
// spills over. `month` is any day in that month.
export function monthGrid(month: string): string[] {
  const first = `${month.slice(0, 7)}-01`;
  const startDow = new Date(`${first}T00:00:00Z`).getUTCDay();
  const start = addDays(first, -startDow);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  // Drop the 6th row if it's entirely next month.
  return days[35].slice(0, 7) !== first.slice(0, 7) ? days.slice(0, 35) : days;
}

// e.g. "November 2026"
export function formatMonth(day: string): string {
  return new Date(`${day.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

// Where a repeating task moves to when it's ticked off: one step on from its
// due date (or from today, if it has none), and keeps stepping until the date
// is after today, so a task that was days overdue doesn't land in the past.
export function nextRepeatDate(repeat: "daily" | "weekly" | "monthly", dueDate: string | null, today: string): string {
  const base = dueDate ?? today;
  // Each step counts from the starting date, so catching up over several
  // months doesn't drift: Jan 31, two months overdue, lands on Mar 31.
  const step = (i: number) =>
    repeat === "daily" ? addDays(base, i) : repeat === "weekly" ? addDays(base, 7 * i) : addMonths(base, i);
  let i = 1;
  let next = step(i);
  while (next <= today) next = step(++i);
  return next;
}

// Ticking a repeating task before its due day counts as doing it early, so
// the app asks first. Returns the due date and where the task would move to,
// or null when it isn't early (due today, overdue, no date, or not repeating).
export function earlyTick(
  task: { repeat: "daily" | "weekly" | "monthly" | null; dueDate: string | null },
  today: string,
): { dueDate: string; nextDate: string } | null {
  if (!task.repeat || !task.dueDate || task.dueDate <= today) return null;
  return { dueDate: task.dueDate, nextDate: nextRepeatDate(task.repeat, task.dueDate, today) };
}

// Overdue = due on an earlier day, or due earlier today at a set time.
export function isOverdue(task: { done: boolean; dueDate: string | null; dueTime: string | null }, now: Now): boolean {
  if (task.done || !task.dueDate) return false;
  if (task.dueDate < now.today) return true;
  return task.dueDate === now.today && !!task.dueTime && task.dueTime < now.time;
}

// "Today", "Tomorrow", "Yesterday", otherwise e.g. "Mon, Nov 17"
// (with the year added when it isn't this year).
export function relDay(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  if (day === addDays(today, -1)) return "Yesterday";
  return formatDay(day, { withYear: day.slice(0, 4) !== today.slice(0, 4) });
}

// e.g. "Sun, Nov 15". Formatted in UTC because a day string has no time zone
// of its own — this stops it from slipping to the day before.
export function formatDay(day: string, { withYear = false } = {}): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

// "17:30" → "5:30 PM"
export function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
