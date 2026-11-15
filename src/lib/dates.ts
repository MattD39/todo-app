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
