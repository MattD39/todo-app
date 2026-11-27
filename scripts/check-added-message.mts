//
// Checks the short message shown after adding a task from the Add task sheet
// ("Added to Upcoming", "Added for Fri, Dec 4", "Added · hidden by your filter").
//
// Run with: npm run check:added-message
//
// Free and quick: no Claude, no database. Checks the plain rule in
// src/lib/views.ts (addedTaskMessage):
//   - Today shows overdue, today and no-date tasks; later → "Added to Upcoming";
//   - Upcoming shows dates after today; anything else → "Added to Today";
//   - Calendar shows the picked day; another day → "Added for <that day>";
//     no date → "Added to Today";
//   - hidden by the category chips → "Added · hidden by your filter";
//   - another screen's message wins over the filter's;
//   - Done always says where it went, and never glows.
// Exits with an error if any check fails.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@/": path.join(root, "src") + path.sep } });
const views = await jiti.import<typeof import("../src/lib/views.ts")>(path.join(root, "src/lib/views.ts"));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `\n      ${detail}` : ""}`);
}

const TODAY = "2026-11-27"; // a Friday
const YESTERDAY = "2026-11-26";
const TOMORROW = "2026-11-28";
const DEC_4 = "2026-12-04"; // Fri, Dec 4

type Screen = import("../src/lib/views.ts").AddScreen;

// expected: the message, or null for "shows right here" (which glows).
function expect(
  name: string,
  task: { dueDate: string | null; category?: string | null },
  where: { screen: Screen; picked?: string[]; calendarDay?: string },
  expected: string | null,
  glow = expected === null,
) {
  const got = views.addedTaskMessage(
    { dueDate: task.dueDate, category: task.category ?? null },
    { screen: where.screen, today: TODAY, picked: where.picked ?? [], calendarDay: where.calendarDay ?? TODAY },
  );
  const ok = got.message === expected && got.glow === glow;
  check(name, ok, `got ${JSON.stringify(got)}, expected ${JSON.stringify({ message: expected, glow })}`);
}

// Today
expect("Today: no date shows here", { dueDate: null }, { screen: "today" }, null);
expect("Today: due today shows here", { dueDate: TODAY }, { screen: "today" }, null);
expect("Today: overdue shows here", { dueDate: YESTERDAY }, { screen: "today" }, null);
expect("Today: tomorrow → Upcoming", { dueDate: TOMORROW }, { screen: "today" }, "Added to Upcoming");

// Upcoming
expect("Upcoming: tomorrow shows here", { dueDate: TOMORROW }, { screen: "upcoming" }, null);
expect("Upcoming: next month shows here", { dueDate: DEC_4 }, { screen: "upcoming" }, null);
expect("Upcoming: due today → Today", { dueDate: TODAY }, { screen: "upcoming" }, "Added to Today");
expect("Upcoming: overdue → Today", { dueDate: YESTERDAY }, { screen: "upcoming" }, "Added to Today");
expect("Upcoming: no date → Today", { dueDate: null }, { screen: "upcoming" }, "Added to Today");

// Calendar
expect("Calendar: on the picked day shows here", { dueDate: DEC_4 }, { screen: "calendar", calendarDay: DEC_4 }, null);
expect("Calendar: today, with today picked, shows here", { dueDate: TODAY }, { screen: "calendar" }, null);
expect(
  "Calendar: another day → that day's date",
  { dueDate: DEC_4 },
  { screen: "calendar", calendarDay: TOMORROW },
  "Added for Fri, Dec 4",
);
expect(
  "Calendar: an earlier day → that day's date",
  { dueDate: YESTERDAY },
  { screen: "calendar" },
  "Added for Thu, Nov 26",
);
expect("Calendar: no date → Today", { dueDate: null }, { screen: "calendar", calendarDay: DEC_4 }, "Added to Today");

// Category chips
expect("Filter: in a chip that's on shows here", { dueDate: null, category: "Work" }, { screen: "today", picked: ["Work"] }, null);
expect(
  "Filter: one of several chips on shows here",
  { dueDate: null, category: "Home" },
  { screen: "today", picked: ["Work", "Home"] },
  null,
);
expect(
  "Filter: other category → hidden",
  { dueDate: null, category: "Home" },
  { screen: "today", picked: ["Work"] },
  "Added · hidden by your filter",
);
expect(
  "Filter: no category → hidden",
  { dueDate: null },
  { screen: "today", picked: ["Work"] },
  "Added · hidden by your filter",
);
expect("Filter: All (no chips) shows everything", { dueDate: null, category: "Home" }, { screen: "today" }, null);
expect(
  "Filter: hidden on the Calendar's picked day",
  { dueDate: DEC_4, category: "Home" },
  { screen: "calendar", picked: ["Work"], calendarDay: DEC_4 },
  "Added · hidden by your filter",
);

// Both: another screen wins
expect(
  "Both: Today + filtered → Upcoming wins",
  { dueDate: TOMORROW, category: "Home" },
  { screen: "today", picked: ["Work"] },
  "Added to Upcoming",
);
expect(
  "Both: Upcoming + filtered → Today wins",
  { dueDate: null, category: "Home" },
  { screen: "upcoming", picked: ["Work"] },
  "Added to Today",
);
expect(
  "Both: Calendar + filtered → date wins",
  { dueDate: DEC_4, category: "Home" },
  { screen: "calendar", picked: ["Work"] },
  "Added for Fri, Dec 4",
);

// Done
expect("Done: no date → Today", { dueDate: null }, { screen: "done" }, "Added to Today");
expect("Done: due today → Today", { dueDate: TODAY }, { screen: "done" }, "Added to Today");
expect("Done: overdue → Today", { dueDate: YESTERDAY }, { screen: "done" }, "Added to Today");
expect("Done: tomorrow → Upcoming", { dueDate: TOMORROW }, { screen: "done" }, "Added to Upcoming");
expect(
  "Done: filtered still says where it went",
  { dueDate: null, category: "Home" },
  { screen: "done", picked: ["Work"] },
  "Added to Today",
);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
if (failures) process.exit(1);
