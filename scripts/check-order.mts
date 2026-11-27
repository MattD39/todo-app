//
// Checks the order tasks show in a list (Today, Upcoming, a Calendar day).
//
// Run with: npm run check:order
//
// Free and quick: no Claude, no database. Checks the plain rules in
// src/lib/views.ts (compareTasks / sortTasks, buildToday, buildUpcoming):
//   1. priority, high first (anything unknown after low);
//   2. due date, soonest first; on a day, timed tasks first in time order;
//      no date last;
//   3. oldest added first;
//   4. added at the same moment: A to Z with numbers read as numbers, capitals ignored.
// Exits with an error if any check fails.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { TaskDTO } from "../src/lib/tasks.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@/": path.join(root, "src") + path.sep } });
const views = await jiti.import<typeof import("../src/lib/views.ts")>(path.join(root, "src/lib/views.ts"));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `\n      ${detail}` : ""}`);
}

const EARLY = "2026-11-01T09:00:00.000Z";
const LATER = "2026-11-02T09:00:00.000Z";
const LATEST = "2026-11-03T09:00:00.000Z";

let nextId = 0;
function task(title: string, extra: Partial<TaskDTO> = {}): TaskDTO {
  nextId++;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    title,
    notes: "",
    priority: "medium",
    dueDate: null,
    dueTime: null,
    repeat: null,
    done: false,
    doneAt: null,
    createdAt: EARLY,
    category: null,
    steps: [],
    completionId: null,
    ...extra,
  };
}

// Sorts the tasks (given in a scrambled order) and checks the titles come out as expected.
function order(name: string, tasks: TaskDTO[], expected: string[], onDay?: string) {
  const got = views.sortTasks([...tasks].reverse(), onDay).map((t) => t.title);
  check(name, JSON.stringify(got) === JSON.stringify(expected), `got ${JSON.stringify(got)}`);
}

console.log("\n1. Priority\n");
order(
  "high, then medium, then low",
  [task("Low", { priority: "low" }), task("High", { priority: "high" }), task("Medium")],
  ["High", "Medium", "Low"],
);
order(
  "no priority (or an unknown one) goes after low",
  [task("None", { priority: null as unknown as TaskDTO["priority"] }), task("Low", { priority: "low" })],
  ["Low", "None"],
);
order(
  "priority beats the date: high due Friday before low overdue for days",
  [
    task("Low, overdue", { priority: "low", dueDate: "2026-11-20" }),
    task("High, Friday", { priority: "high", dueDate: "2026-11-28" }),
  ],
  ["High, Friday", "Low, overdue"],
);

console.log("\n2. Due date and time\n");
order(
  "soonest date first (most overdue first)",
  [task("Nov 25", { dueDate: "2026-11-25" }), task("Nov 20", { dueDate: "2026-11-20" }), task("Nov 22", { dueDate: "2026-11-22" })],
  ["Nov 20", "Nov 22", "Nov 25"],
);
order(
  "same day: timed tasks first in time order, then no time",
  [
    task("No time", { dueDate: "2026-11-27" }),
    task("14:00", { dueDate: "2026-11-27", dueTime: "14:00" }),
    task("09:00", { dueDate: "2026-11-27", dueTime: "09:00" }),
  ],
  ["09:00", "14:00", "No time"],
);
order(
  "a date goes before no date (same priority)",
  [task("Anytime", { createdAt: EARLY }), task("Dated", { dueDate: "2026-12-31", createdAt: LATEST })],
  ["Dated", "Anytime"],
);
order(
  "the date beats when it was added",
  [task("Old, later date", { dueDate: "2026-11-30", createdAt: EARLY }), task("New, sooner", { dueDate: "2026-11-28", createdAt: LATEST })],
  ["New, sooner", "Old, later date"],
);

console.log("\n3. Oldest added first\n");
order(
  "no date: oldest added first, whatever the names",
  [task("AAA", { createdAt: LATEST }), task("Zebra", { createdAt: EARLY }), task("Middle", { createdAt: LATER })],
  ["Zebra", "Middle", "AAA"],
);
order(
  "same day and time: oldest added first",
  [task("B new", { dueDate: "2026-11-27", createdAt: LATER }), task("Z old", { dueDate: "2026-11-27", createdAt: EARLY })],
  ["Z old", "B new"],
);

console.log("\n4. Added at the same moment: A to Z, numbers as numbers\n");
order("\"Shift 2\" before \"Shift 10\"", [task("Shift 10"), task("Shift 2"), task("Shift 1")], ["Shift 1", "Shift 2", "Shift 10"]);
order("plain numbers: 2 before 10", [task("10"), task("2"), task("1")], ["1", "2", "10"]);
order("capitals don't matter", [task("banana"), task("Apple"), task("cherry")], ["Apple", "banana", "cherry"]);

console.log("\nCalendar: Repeats here\n");
order(
  "sorted as if due on the picked day (their own dates are earlier)",
  [
    task("Gym (from Nov 20)", { dueDate: "2026-11-20", createdAt: LATER, repeat: "weekly" }),
    task("Bins (from Nov 26)", { dueDate: "2026-11-26", createdAt: EARLY, repeat: "weekly" }),
  ],
  ["Bins (from Nov 26)", "Gym (from Nov 20)"],
  "2026-12-04",
);

console.log("\nScreens\n");
const now = { today: "2026-11-27", time: "12:00" } as Parameters<typeof views.buildToday>[2];
const open = [
  task("Upcoming low, Dec 1", { priority: "low", dueDate: "2026-12-01" }),
  task("Upcoming high, Dec 5", { priority: "high", dueDate: "2026-12-05" }),
  task("Upcoming, Nov 29", { dueDate: "2026-11-29" }),
  task("Overdue low, 5 days", { priority: "low", dueDate: "2026-11-22" }),
  task("Overdue high, 1 day", { priority: "high", dueDate: "2026-11-26" }),
  task("Today Task 10", { dueDate: "2026-11-27" }),
  task("Today Task 2", { dueDate: "2026-11-27" }),
  task("Today high", { priority: "high", dueDate: "2026-11-27" }),
  task("Anytime new", { createdAt: LATER }),
  task("Anytime old", { createdAt: EARLY }),
];
const snapshot = JSON.stringify(open);
const today = views.buildToday(open, [], now, "UTC");
const titles = (list: TaskDTO[]) => JSON.stringify(list.map((t) => t.title));
check(
  "Today, Overdue: high 1 day before low 5 days",
  titles(today.overdue) === JSON.stringify(["Overdue high, 1 day", "Overdue low, 5 days"]),
  titles(today.overdue),
);
check(
  "Today, Due today: high first, then Task 2 before Task 10",
  titles(today.dueToday) === JSON.stringify(["Today high", "Today Task 2", "Today Task 10"]),
  titles(today.dueToday),
);
check(
  "Today, Anytime: oldest first",
  titles(today.anytime) === JSON.stringify(["Anytime old", "Anytime new"]),
  titles(today.anytime),
);
const upcoming = views.buildUpcoming([...open].reverse(), now);
check(
  "Upcoming: days stay in date order even when a later day has a high task",
  JSON.stringify(upcoming.map((d) => d.day)) === JSON.stringify(["2026-11-29", "2026-12-01", "2026-12-05"]),
  JSON.stringify(upcoming.map((d) => d.day)),
);
check("the list passed in isn't changed", JSON.stringify(open) === snapshot);

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
