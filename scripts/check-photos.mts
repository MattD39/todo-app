//
// Checks Photo to schedule: Claude reading made-up work schedules and turning
// the shifts into tasks.
//
// Run with: npm run check:photos   (or: npm run check:photos -- --free  for the free checks only)
//
// Part 1 (free, no Claude): the photo checks (real photo types only, size
//   limit), shift titles, the calendar, and the shift rules (the weekday must
//   match the date, no past days, no duplicates, at most 20 shifts).
// Part 2 (asks Claude, about half a cent per photo): the made-up schedules in
//   tests/schedule-photos/. Each is shrunk the way the phone will shrink it,
//   then sent like a chat message. Prints what Claude said, the shifts it
//   would add, and what each photo cost.
// Part 3 (asks Claude): your own photos in tests/schedule-photos/mine/ (that
//   folder is never committed). No expected answers: just prints the results.
//
// Nothing is saved: changes are only queued, never sent to the database, and
// the photos only go to Claude. "Today" is fixed at Friday 2026-11-20, so the
// expected dates never go out of date. Exits with an error if any check fails.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { createJiti } from "jiti";
import sharp from "sharp";
import type { ChatChange } from "../src/lib/chat-changes.ts";
import type { ChatTurn } from "../src/lib/ai.ts";
import type { ChatPhoto } from "../src/lib/schedule-photo.ts";
import type { TaskDTO } from "../src/lib/tasks.ts";

// Load the app's server code (which normally only runs inside Next.js).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "server-only": path.join(root, "scripts/server-only-stub.cjs"),
    "@/": path.join(root, "src") + path.sep,
  },
});
const ai = await jiti.import<typeof import("../src/lib/ai.ts")>(path.join(root, "src/lib/ai.ts"));
const sp = await jiti.import<typeof import("../src/lib/schedule-photo.ts")>(
  path.join(root, "src/lib/schedule-photo.ts"),
);
const { cleanChat } = await jiti.import<typeof import("../src/lib/ai-request.ts")>(
  path.join(root, "src/lib/ai-request.ts"),
);
const { ClaudeMeter, costOf } = await jiti.import<typeof import("../src/lib/claude.ts")>(
  path.join(root, "src/lib/claude.ts"),
);

const photosDir = path.join(root, "tests/schedule-photos");
const NOW = { today: "2026-11-20", time: "10:00" }; // a Friday
const TIME_ZONE = "America/Halifax";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `\n      ${detail}` : ""}`);
}

function task(id: string, title: string, extra: Partial<TaskDTO> = {}): TaskDTO {
  return {
    id,
    title,
    notes: "",
    priority: "medium",
    dueDate: null,
    dueTime: null,
    repeat: null,
    done: false,
    doneAt: null,
    category: null,
    steps: [],
    completionId: null,
    ...extra,
  };
}

let callId = 0;
const call = (name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock =>
  ({ type: "tool_use", id: `call_${++callId}`, name, input }) as Anthropic.ToolUseBlock;
const shiftCall = (date: string, weekday: string, start = "09:00", end = "17:00", person: string | null = null) =>
  call("add_shift", { date, weekday, start, end, person });

// ─── Part 1: free checks ─────────────────────────────────────────────────────

console.log("\nPart 1: the app's own checks (free)\n");

const tinyJpeg = (
  await sharp({ create: { width: 40, height: 30, channels: 3, background: "#fff" } })
    .jpeg()
    .toBuffer()
).toString("base64");
const tinyPng = (
  await sharp({ create: { width: 40, height: 30, channels: 3, background: "#fff" } })
    .png()
    .toBuffer()
).toString("base64");
const tinyGif = (
  await sharp({ create: { width: 40, height: 30, channels: 3, background: "#fff" } })
    .gif()
    .toBuffer()
).toString("base64");
check("no photo is fine", sp.cleanPhoto(undefined) === null);
check(
  "a JPEG is accepted (type read from its own bytes)",
  (sp.cleanPhoto({ data: tinyJpeg }) as ChatPhoto)?.mediaType === "image/jpeg",
);
check("a PNG is accepted", (sp.cleanPhoto({ data: tinyPng }) as ChatPhoto)?.mediaType === "image/png");
check("a GIF is refused", typeof sp.cleanPhoto({ data: tinyGif }) === "string");
check(
  "text pretending to be a photo is refused",
  typeof sp.cleanPhoto({ data: Buffer.from("hello, I am not a photo!").toString("base64") }) === "string",
);
check("broken base64 is refused", typeof sp.cleanPhoto({ data: "not base64 at all!!" }) === "string");
const huge = "/9j/" + "A".repeat(Math.ceil((sp.MAX_PHOTO_BYTES * 4) / 3 / 4) * 4);
check("a photo over 3 MB is refused", sp.cleanPhoto({ data: huge }) === "That photo is too big. Try a smaller one.");

check('title: "Work 9 AM–5 PM"', sp.shiftTitle("09:00", "17:00") === "Work 9 AM–5 PM");
check(
  'title with minutes and a name: "Jess work 9:30 AM–5 PM"',
  sp.shiftTitle("09:30", "17:00", "Jess") === "Jess work 9:30 AM–5 PM",
);
check("title at noon: 12 PM", sp.shiftTitle("12:00", "20:00") === "Work 12 PM–8 PM");
check("overnight shift says it ends next day", sp.shiftTitle("22:00", "06:00") === "Work 10 PM–6 AM (ends next day)");
check("2026-11-23 is a Monday", sp.weekdayOf("2026-11-23") === "Monday");
const calendar = sp.describeCalendar(NOW.today);
check(
  "the calendar starts this Monday, marks today, and runs four weeks",
  calendar.includes("Mon, Nov 16 = 2026-11-16") &&
    calendar.includes("Fri, Nov 20 = 2026-11-20 (today)") &&
    calendar.includes("Sun, Dec 13 = 2026-12-13"),
);

const noTasks = new Map<string, TaskDTO>();
let queue: ChatChange[] = [];
const good = ai.queueChange(shiftCall("2026-11-23", "Monday"), noTasks, queue, NOW.today);
const queued = queue[0];
check(
  "a good shift is queued as the right task",
  good.ok &&
    queued?.kind === "add" &&
    queued.shift === true &&
    queued.task.title === "Work 9 AM–5 PM" &&
    queued.task.dueDate === "2026-11-23" &&
    queued.task.dueTime === "09:00" &&
    queued.task.category === "Work",
  JSON.stringify(queued),
);
check(
  "a weekday that doesn't match the date is refused",
  !ai.queueChange(shiftCall("2026-11-24", "Monday"), noTasks, [], NOW.today).ok,
);
check("a day already past is refused", !ai.queueChange(shiftCall("2026-11-19", "Thursday"), noTasks, [], NOW.today).ok);
check(
  "bad times are refused",
  !ai.queueChange(shiftCall("2026-11-23", "Monday", "9am", "5pm"), noTasks, [], NOW.today).ok,
);
const existing = new Map([["T1", task("t1", "Work 9 AM–5 PM", { dueDate: "2026-11-23", dueTime: "09:00" })]]);
check(
  "a shift already on the list is refused",
  !ai.queueChange(shiftCall("2026-11-23", "Monday"), existing, [], NOW.today).ok,
);

// Duplicates (5c-1): same day + same start and end = the same shift, if the
// names match (any capitals) or one of them has no name.
const onMonday = (title: string) =>
  new Map([["T1", task("t1", title, { dueDate: "2026-11-23", dueTime: "09:00" })]]);
const mondayShift = (person: string | null, start = "09:00", end = "17:00") =>
  shiftCall("2026-11-23", "Monday", start, end, person);
const refusedAsOnList = (r: { ok: boolean; message: string }) => !r.ok && /already on the user/.test(r.message);
// 5c-4 (user's decision): no name = the user's own shift, so an unnamed shift
// and a named one are different people's, both ways round.
check(
  "different people: the user's own unnamed 9–5 on the list, Elena's 9–5 is added",
  ai.queueChange(mondayShift("Elena"), onMonday("Work 9 AM–5 PM"), [], NOW.today).ok,
);
check(
  "different people: Elena's 9–5 on the list, the user's own unnamed 9–5 is added (no question)",
  ai.queueChange(mondayShift(null), onMonday("Elena work 9 AM–5 PM"), [], NOW.today).ok,
);
const elenaAndMine = new Map([
  ["T1", task("t1", "Elena work 9 AM–5 PM", { dueDate: "2026-11-23", dueTime: "09:00" })],
  ["T2", task("t2", "Work 9 AM–5 PM", { dueDate: "2026-11-23", dueTime: "09:00" })],
]);
check(
  "same person: the user's own 9–5 already there (next to Elena's) is refused as already on the list",
  refusedAsOnList(ai.queueChange(mondayShift(null), elenaAndMine, [], NOW.today)),
);
check(
  "same person: Elena's 9–5 already there is refused as already on the list",
  refusedAsOnList(ai.queueChange(mondayShift("Elena"), onMonday("Elena work 9 AM–5 PM"), [], NOW.today)),
);
check(
  "different people, overlapping times: the user's own 9–5 on the list, Elena's 10–6 is added",
  ai.queueChange(mondayShift("Elena", "10:00", "18:00"), onMonday("Work 9 AM–5 PM"), [], NOW.today).ok,
);
check(
  "duplicate: the same name in different capitals is refused",
  refusedAsOnList(ai.queueChange(mondayShift("elena"), onMonday("Elena work 9 AM–5 PM"), [], NOW.today)),
);
check(
  "two different names, same day and times, are both allowed (Elena on the list, Marcus added)",
  ai.queueChange(mondayShift("Marcus"), onMonday("Elena work 9 AM–5 PM"), [], NOW.today).ok,
);
check(
  "a different time on the same day that doesn't overlap is allowed (9–5, then 6–10 PM)",
  ai.queueChange(mondayShift(null, "18:00", "22:00"), onMonday("Work 9 AM–5 PM"), [], NOW.today).ok,
);
check(
  "the same times on a different day are allowed",
  ai.queueChange(shiftCall("2026-11-24", "Tuesday"), onMonday("Work 9 AM–5 PM"), [], NOW.today).ok,
);
check(
  "a hand-typed \"work 9am-5pm\" counts as the same shift",
  refusedAsOnList(ai.queueChange(mondayShift(null), onMonday("work 9am-5pm"), [], NOW.today)),
);
check(
  "an ordinary task on that day isn't mistaken for a shift",
  ai.queueChange(mondayShift(null), onMonday("Call the dentist"), [], NOW.today).ok,
);
const finishedMonday = [task("f1", "Work 9 AM–5 PM", { dueDate: "2026-11-23", dueTime: "09:00", done: true })];
check(
  "a shift already finished this week is refused",
  refusedAsOnList(ai.queueChange(mondayShift(null), noTasks, [], NOW.today, finishedMonday)),
);
queue = [];
ai.queueChange(mondayShift("Elena"), noTasks, queue, NOW.today);
check(
  "in one reply: Elena's shift, then the user's own at the same time, are both queued",
  ai.queueChange(mondayShift(null), noTasks, queue, NOW.today).ok && queue.length === 2,
);
check(
  "in one reply: then Marcus's at the same time is queued too",
  ai.queueChange(mondayShift("Marcus"), noTasks, queue, NOW.today).ok && queue.length === 3,
);
check(
  "in one reply: the user's own again is refused",
  !ai.queueChange(mondayShift(null), noTasks, queue, NOW.today).ok && queue.length === 3,
);

// Overlapping shifts (5c-3 test 6, user's decision): the same person (same
// name, or no name on either) with a shift that day whose times overlap is
// NOT added; Claude is told to ask which is right. No overlap = added.
const onWed = (...titles: string[]) =>
  new Map(titles.map((t, i) => [`T${i + 1}`, task(`w${i}`, t, { dueDate: "2026-11-25", dueTime: "11:00" })]));
const wedShift = (start: string, end: string, person: string | null = null) =>
  shiftCall("2026-11-25", "Wednesday", start, end, person);
const overlapRefused = (r: { ok: boolean; message: string }) => !r.ok && /overlaps/.test(r.message) && /which is right/.test(r.message);
const wedOverlap = ai.queueChange(wedShift("11:00", "19:00"), onWed("Work 11 AM–6 PM"), [], NOW.today);
check(
  "overlap: 11 AM–6 PM on the list, photo says 11 AM–7 PM: NOT added, Claude told to ask which is right",
  overlapRefused(wedOverlap),
  wedOverlap.message,
);
check(
  "overlap: the same name (any capitals) with overlapping times is NOT added",
  overlapRefused(ai.queueChange(wedShift("12:00", "20:00", "elena"), onWed("Elena work 11 AM–6 PM"), [], NOW.today)),
);
check(
  "overlap: a ticked-off shift that overlaps also stops it",
  overlapRefused(
    ai.queueChange(wedShift("11:00", "19:00"), new Map(), [], NOW.today, [
      task("f1", "Work 11 AM–6 PM", { dueDate: "2026-11-25", dueTime: "11:00", done: true }),
    ]),
  ),
);
check(
  "overlap: an overnight shift on the list overlapping the photo's is NOT added",
  overlapRefused(ai.queueChange(wedShift("23:00", "07:00"), onWed("Work 10 PM–6 AM (ends next day)"), [], NOW.today)),
);
check(
  "no overlap: split shifts (6–10 AM on the list, 4–9 PM in the photo) are added",
  ai.queueChange(wedShift("16:00", "21:00"), onWed("Work 6 AM–10 AM"), [], NOW.today).ok,
);
check(
  "no overlap: back to back (6–10 AM, then 10 AM–2 PM) is added",
  ai.queueChange(wedShift("10:00", "14:00"), onWed("Work 6 AM–10 AM"), [], NOW.today).ok,
);
check(
  "no overlap check across people: Elena 11–6 on the list, Marcus 11–7 is added",
  ai.queueChange(wedShift("11:00", "19:00", "Marcus"), onWed("Elena work 11 AM–6 PM"), [], NOW.today).ok,
);
check(
  "exact same shift still says \"already on the list\" (not the overlap question)",
  refusedAsOnList(ai.queueChange(wedShift("11:00", "18:00"), onWed("Work 11 AM–6 PM"), [], NOW.today)),
);

// Prompt caching prices (Haiku 5.5: $0.10 per million input tokens; cache
// writes 1.25×, cache reads 0.1×), as the daily spending cap counts them.
const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;
// (100,000 tokens: above that, Haiku's higher "long request" price applies.)
check("cost: 100,000 plain input tokens = $0.01", near(costOf(100_000, 0), 0.01));
check("cost: 100,000 input read from the cache = $0.001", near(costOf(100_000, 0, 0, 100_000), 0.001));
check("cost: 100,000 input written to the cache = $0.0125", near(costOf(100_000, 0, 100_000, 0), 0.0125));
check(
  "cost: a mix (6,000 read + 1,000 written + 500 new in, 200 out) adds up",
  near(costOf(7_500, 200, 1_000, 6_000), (500 * 0.1 + 1_000 * 0.125 + 6_000 * 0.01 + 200 * 0.5) / 1_000_000),
);

// Names (5c-4): a name goes in a title only if the user typed it.
const typed = (...texts: string[]) => sp.typedWords(texts);
const nameCases: [string, string, Map<string, string>, string | null][] = [
  // what's checked, the name Claude sent, what the user typed, the name used ("" = none, null = refused)
  ["a typed name is used", "Elena", typed("Add Elena's shifts."), "Elena"],
  ['"Elena\'s" counts as "Elena"', "Elena", typed("Add Elena's shifts"), "Elena"],
  ["capitals are ignored when matching", "Elena", typed("add ELENA shifts"), "ELENA"],
  ['all small letters get a capital first ("elena" → "Elena")', "elena", typed("add elena's shifts"), "Elena"],
  ["capitals the user typed are kept exactly", "Mcdonald", typed("add McDonald's shifts"), "McDonald"],
  ['a word only on the photo is dropped ("Elena Ruiz" → "Elena")', "Elena Ruiz", typed("Add Elena's shifts."), "Elena"],
  ["a name only on the photo is refused", "Riley Chen", typed("Add these shifts please."), null],
  ["no name stays no name", "", typed("Add these shifts please."), ""],
  ['"me" is never a name', "Me", typed("add the shifts for me"), null],
  ['"myself" is never a name', "Myself", typed("I'll do it myself"), null],
  ['"we", "us", "our" are never names', "Our", typed("we work these, add them for us, our shifts"), null],
  ['"shift", "work", "add", "schedule" are never names', "Work", typed("add the work shift from my schedule"), null],
  ['"shifts" is never a name', "Shifts", typed("add shifts"), null],
];
for (const [name, sent, words, expected] of nameCases) {
  const got = sp.typedName(sent, words);
  check(`name: ${name}`, got === expected, JSON.stringify(got));
}
const typedElena = typed("Add Elena's shifts.");
const elenaOnMonday = onMonday("Elena work 9 AM–5 PM");
check(
  'name first: Claude\'s "Elena Ruiz" is the same as an existing "Elena work 9 AM–5 PM" (already on the list)',
  refusedAsOnList(ai.queueChange(mondayShift("Elena Ruiz"), elenaOnMonday, [], NOW.today, [], typedElena)),
);
queue = [];
ai.queueChange(mondayShift("Elena Ruiz"), noTasks, queue, NOW.today, [], typedElena);
check(
  'the title uses the typed name: "Elena work 9 AM–5 PM"',
  queue[0]?.kind === "add" && queue[0].task.title === "Elena work 9 AM–5 PM",
  JSON.stringify(queue[0]),
);
const printedOnly = ai.queueChange(mondayShift("Riley Chen"), noTasks, [], NOW.today, [], typed("Add these shifts please."));
check(
  "a shift named only by the photo is NOT added; Claude is told to ask or use no name",
  !printedOnly.ok && /isn't a name the user typed/.test(printedOnly.message),
  printedOnly.message,
);

// Fixing a shift's time (5c-2b): the existing task changes; nothing is added.
const wednesday = (title: string, dueTime = "12:00") =>
  new Map([["T1", task("t1", title, { dueDate: "2026-11-25", dueTime })]]);
const fixCall = (start: string, end: string, label = "T1") => call("fix_shift", { task: label, start, end });
const fixedTo = (q: ChatChange[]) => {
  const c = q[0];
  return q.length === 1 && c.kind === "update" ? `${c.changes.title} ${c.changes.dueTime ?? "(time unchanged)"}` : JSON.stringify(q);
};
queue = [];
ai.queueChange(fixCall("12:00", "18:00"), wednesday("Work 12 PM–8 PM"), queue, NOW.today);
check('fix: "ends at 6, not 8" renames the shift; due time stays', fixedTo(queue) === "Work 12 PM–6 PM (time unchanged)", fixedTo(queue));
queue = [];
ai.queueChange(fixCall("13:00", "20:00"), wednesday("Work 12 PM–8 PM"), queue, NOW.today);
check("fix: a new start also moves the due time", fixedTo(queue) === "Work 1 PM–8 PM 13:00", fixedTo(queue));
queue = [];
ai.queueChange(fixCall("10:00", "17:00"), wednesday("Elena work 9 AM–5 PM", "09:00"), queue, NOW.today);
check("fix: keeps the name in the title", fixedTo(queue) === "Elena work 10 AM–5 PM 10:00", fixedTo(queue));
queue = [];
ai.queueChange(fixCall("12:00", "18:00"), wednesday("work 12pm-8pm"), queue, NOW.today);
check('fix: a hand-typed "work 12pm-8pm" gets the usual title', fixedTo(queue) === "Work 12 PM–6 PM (time unchanged)", fixedTo(queue));
check("fix: not a shift is refused", !ai.queueChange(fixCall("12:00", "18:00"), wednesday("Buy milk"), [], NOW.today).ok);
check(
  "fix: the same times again is refused (nothing would change)",
  !ai.queueChange(fixCall("12:00", "20:00"), wednesday("Work 12 PM–8 PM"), [], NOW.today).ok,
);
const twoOnWednesday = new Map([
  ["T1", task("t1", "Work 12 PM–8 PM", { dueDate: "2026-11-25", dueTime: "12:00" })],
  ["T2", task("t2", "Work 12 PM–6 PM", { dueDate: "2026-11-25", dueTime: "12:00" })],
]);
check(
  "fix: refused if it would become a copy of another shift that day",
  !ai.queueChange(fixCall("12:00", "18:00"), twoOnWednesday, [], NOW.today).ok,
);
check(
  "update_task can't change a shift's time (fix_shift must)",
  !ai.queueChange(call("update_task", { task: "T1", due_time: "13:00" }), wednesday("Work 12 PM–8 PM"), [], NOW.today).ok,
);
check(
  "update_task can still move a shift to another day",
  ai.queueChange(call("update_task", { task: "T1", due_date: "2026-11-26" }), wednesday("Work 12 PM–8 PM"), [], NOW.today).ok,
);

// The safety net for "I'll add it" with no tool used: plain promises count,
// offers for later never do (making those would be guessing).
const promiseCases: [string, boolean][] = [
  ["I'll add the Monday shift for Matt, 9 AM–5 PM on Mon, Dec 7.", true],
  ["I'll add Sunday, Nov 29, 11 AM–7 PM.\n\nYour Thursday shift isn't on your list, so tell me if you want it.", true],
  ["I’ll change Wednesday's shift to 12 PM–6 PM.", true],
  ["If you tell me its start and end times, I'll add it too.", false],
  ["Tell me which week and I'll add the shifts.", false],
  ["Do you want me to add it? I'll add it once you say so.", false],
  ["All five shifts are already on your list, so I didn't add anything.", false],
];
for (const [text, counts] of promiseCases) {
  check(`safety net ${counts ? "catches" : "ignores"}: ${JSON.stringify(text.split("\n")[0])}`, (ai.unkeptPromise(text) !== null) === counts);
}

// 5c-3: what's shown of the text Claude writes after the app answered its
// changes. Only a promise repeating an earlier promise is dropped; questions
// and everything else always show.
const said = "I'll add the four shifts I can read: Monday, Wednesday, Friday and Sunday.";
const laterCases: [string, string, string, boolean, string][] = [
  // name, earlier text, later text, all changes queued?, expected shown text
  ["drops a repeated promise", "I'll add Thursday, Nov 26, 7 AM–3 PM.", "I'll add the Thursday shift, Work 7 AM–3 PM on Nov 26.", true, ""],
  ["drops a repeat with short day names", said, "I'll add the Mon, Wed, Fri and Sun shifts.", true, ""],
  [
    "promise repeated + Thursday question: the QUESTION still shows",
    said,
    "I'll add the Mon, Wed, Fri and Sun shifts. What time is your Thursday, Dec 3, shift?",
    true,
    "What time is your Thursday, Dec 3, shift?",
  ],
  [
    'keeps an ask with no "?" ("If you tell me…")',
    said,
    "I'll add the Mon, Wed, Fri and Sun shifts. Once you tell me Thursday's time, I'll add that one too.",
    true,
    "Once you tell me Thursday's time, I'll add that one too.",
  ],
  ["keeps a promise about a different day", "I'll add Monday's shift.", "I'll add Thursday's shift too.", true, "I'll add Thursday's shift too."],
  ["keeps a promise at a different time", "I'll add Monday, 9 AM–5 PM.", "I'll add Monday, 10 AM–5 PM.", true, "I'll add Monday, 10 AM–5 PM."],
  ["keeps everything when a change was refused", "I'll add Friday.", "I'll add Friday. It was already on your list.", false, "I'll add Friday. It was already on your list."],
  ["keeps everything when nothing was promised before", "Here's what I read:\n- Mon: 9 AM–5 PM", "I'll add Monday.", true, "I'll add Monday."],
  ["keeps a repeated sentence that isn't a promise", said + " Thursday is hidden.", "Thursday is hidden.", true, "Thursday is hidden."],
  ["keeps a note that isn't a promise", said, "Tuesday and Saturday are days off.", true, "Tuesday and Saturday are days off."],
];
for (const [name, earlier, later, allQueued, expected] of laterCases) {
  const shownText = ai.laterRoundText(earlier, later, allQueued);
  check(`after the app answers: ${name}`, shownText === expected, JSON.stringify(shownText));
}

queue = [];
let allOk = true;
for (let i = 0; i < 20; i++) {
  const day = new Date(Date.UTC(2026, 10, 23 + Math.floor(i / 2))).toISOString().slice(0, 10); // two a day from Nov 23
  const start = i % 2 ? "16:00" : "06:00";
  allOk &&= ai.queueChange(
    shiftCall(day, sp.weekdayOf(day), start, i % 2 ? "21:00" : "10:00"),
    noTasks,
    queue,
    NOW.today,
  ).ok;
}
check("20 shifts fit in one message", allOk && queue.length === 20);
check(
  "a 21st shift is refused, and ALL that reply's shifts are dropped (more than 20 adds none)",
  !ai.queueChange(shiftCall("2026-12-20", "Sunday"), noTasks, queue, NOW.today).ok && queue.length === 0,
  `${queue.length} still queued`,
);
queue = [];
for (let i = 0; i < 10; i++) ai.queueChange(call("add_task", { title: `Task ${i}` }), noTasks, queue, NOW.today);
check(
  "other changes still stop at 10",
  queue.length === 10 && !ai.queueChange(call("add_task", { title: "Eleven" }), noTasks, queue, NOW.today).ok,
);
check(
  "…but shifts can still be added after them (up to 20 in all)",
  ai.queueChange(shiftCall("2026-11-23", "Monday"), noTasks, queue, NOW.today).ok,
);

// The Chat screen sends older messages again with just "had a photo" (never
// the photo). One sent with no words must not be dropped, or Claude's reply
// to it would lose its question.
const older = cleanChat([
  { role: "user", text: "", hadPhoto: true },
  { role: "assistant", text: "I read 5 shifts and added them." },
  { role: "user", text: "Thanks" },
]);
check(
  "an older photo-only message stays in the chat",
  older.length === 3 && older[0].hadPhoto === true && older[0].text === sp.PHOTO_ONLY_MESSAGE,
);

// ─── g4: one-off categories and "Save it to your list?" (free) ───────────────
console.log("\ng4: one-off categories (free)\n");
{
  const cats = (saved: string[], oneOffs: string[] = []) => ({ saved, known: [...saved, ...oneOffs].sort() });
  const labelled = new Map([["T1", task("t1", "Buy milk")]]);
  const asks = (m: string) => /Save it to your list\?/.test(m) || /Save \S+ to your list\?/.test(m);
  const msg = (c: Anthropic.ToolUseBlock, q: ChatChange[], categories?: ReturnType<typeof cats>, today = NOW.today) =>
    ai.queueChange(c, labelled, q, today, [], undefined, categories).message;

  let q: ChatChange[] = [];
  check(
    "add_task with a saved category (any capitals): no question",
    !asks(msg(call("add_task", { title: "Run", category: "fitness" }), q, cats(["Fitness"]))),
  );
  q = [];
  let m = msg(call("add_task", { title: "Buy bread", category: "Groceries" }), q, cats(["Fitness"]));
  check("add_task with a category that isn't saved: tells Claude to ask \"Save it to your list?\"", asks(m) && /one-off/.test(m), m);
  m = msg(call("add_task", { title: "Buy eggs", category: "groceries" }), q, cats(["Fitness"]));
  check("…but only once per category in one reply", !asks(m), m);
  check(
    "…and a one-off the user already has asks too (only shifts ask just the first time)",
    asks(msg(call("add_task", { title: "Buy jam", category: "Shop" }), [], cats(["Fitness"], ["Shop"]))),
  );
  check(
    "update_task to a category that isn't saved asks too",
    asks(msg(call("update_task", { task: "T1", category: "Groceries" }), [], cats(["Fitness"]))),
  );
  check(
    "older checks with no category list: no question (unchanged behaviour)",
    !asks(msg(call("add_task", { title: "Buy bread", category: "Groceries" }), [], undefined)),
  );

  // Shifts (category Work): ask the first time only.
  q = [];
  m = msg(shiftCall("2026-11-23", "Monday"), q, cats(["Fitness"]));
  check("first shifts ever, no Work category at all: asks \"Save Work to your list?\"", /Save Work to your list\?/.test(m), m);
  m = msg(shiftCall("2026-11-24", "Tuesday"), q, cats(["Fitness"]));
  check("…once per reply, not for every shift", !asks(m), m);
  check(
    "Work used before as a one-off (the user said no): later shifts don't ask",
    !asks(msg(shiftCall("2026-11-23", "Monday"), [], cats(["Fitness"], ["Work"]))),
  );
  check("Work saved: shifts don't ask", !asks(msg(shiftCall("2026-11-23", "Monday"), [], cats(["work"]))));
  check(
    "…but a normal task put in an unsaved Work still asks",
    asks(msg(call("add_task", { title: "Email boss", category: "Work" }), [], cats(["Fitness"], ["Work"]))),
  );

  // save_category
  q = [];
  let r = ai.queueChange(call("save_category", { name: "  groceries " }), labelled, q, NOW.today, [], undefined, cats([], ["Groceries"]));
  check(
    "save_category queues saving it, with the capitals of the one-off they already have",
    r.ok && q.length === 1 && q[0].kind === "save-category" && q[0].name === "Groceries",
    JSON.stringify(q),
  );
  r = ai.queueChange(call("save_category", { name: "Groceries" }), labelled, q, NOW.today, [], undefined, cats([], ["Groceries"]));
  check("…asking twice queues it once", q.length === 1, JSON.stringify(q));
  r = ai.queueChange(call("save_category", { name: "FITNESS" }), labelled, [], NOW.today, [], undefined, cats(["Fitness"]));
  check("…already saved: refused, says so", !r.ok && /already on the user's saved list/.test(r.message), r.message);
  r = ai.queueChange(call("save_category", { name: "  " }), labelled, [], NOW.today, [], undefined, cats([]));
  check("…a blank name is refused", !r.ok);
  m = msg(call("add_task", { title: "Buy bread", category: "Groceries" }), q, cats([], ["Groceries"]));
  check("an add after save_category for that same category in the reply: no question", !asks(m), m);
  check(
    "\"I'll save Groceries to your list.\" counts as a promise (the safety net catches a missed tool call)",
    ai.unkeptPromise("I'll save Groceries to your list.") !== null,
  );
}

// ─── Part 2: Claude reads the made-up schedules ──────────────────────────────

// Shrinks a photo the way the phone will (longest side 2000 px, JPEG), then
// checks it like the server does.
async function loadPhoto(file: string): Promise<{ photo: ChatPhoto; tokens: number; kb: number }> {
  const { data, info } = await sharp(file)
    .rotate()
    .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  const photo = sp.cleanPhoto({ data: data.toString("base64") });
  if (!photo || typeof photo === "string") throw new Error(`${path.basename(file)}: ${photo}`);
  return {
    photo,
    tokens: Math.ceil(info.width / 28) * Math.ceil(info.height / 28),
    kb: Math.round(data.length / 1024),
  };
}

type Result = { reply: string; queue: ChatChange[]; cost: number };
let totalCost = 0;
let lastMeter: InstanceType<typeof ClaudeMeter> | undefined; // the newest ask()'s meter

async function ask(
  turns: ChatTurn[],
  photo: ChatPhoto | null,
  open: TaskDTO[] = [task("m1", "Buy milk")],
  finished: TaskDTO[] = [],
  categories?: { saved: string[]; known: string[] }, // g4: the saved list (left out = older checks)
): Promise<Result> {
  const meter = new ClaudeMeter();
  const queue: ChatChange[] = [];
  let reply = "";
  const snapshot = { open, history: { done: finished, ticks: [] }, now: NOW, timeZone: TIME_ZONE, categories };
  for await (const piece of ai.chatAboutTasks(turns, snapshot, new AbortController().signal, queue, meter, photo)) {
    reply += piece;
  }
  totalCost += meter.costUsd;
  console.log(`  Claude: ${reply.trim().replace(/\n/g, "\n          ")}`);
  for (const c of queue)
    console.log(`  would add: ${c.summary}${c.kind === "add" && c.shift ? "" : "  (NOT a shift)"}`);
  if (queue.length === 0) console.log("  would add: nothing");
  console.log(
    `  cost: $${meter.costUsd.toFixed(4)} (${meter.inputTokens} tokens in: ${meter.cacheReadTokens} read from ` +
      `cache, ${meter.cacheWriteTokens} written to cache; ${meter.outputTokens} out)`,
  );
  lastMeter = meter;
  // 5c-3: a reply that makes changes says what it'll do once, not twice.
  if (queue.length > 0) {
    const promises = reply.split(/(?<=[.!?])\s+|\n+/).filter((s) => ai.unkeptPromise(s) !== null);
    check("says what it'll do only once (no repeated sentence)", promises.length <= 1, promises.join(" | "));
  }
  return { reply, queue, cost: meter.costUsd };
}

const shiftsOf = (q: ChatChange[]) =>
  q
    .filter((c): c is Extract<ChatChange, { kind: "add" }> => c.kind === "add")
    .map((c) => `${c.task.dueDate} ${c.task.dueTime} ${c.task.title}`)
    .sort();
const same = (q: ChatChange[], expected: string[]) =>
  JSON.stringify(shiftsOf(q)) === JSON.stringify([...expected].sort());
const onlyShifts = (q: ChatChange[]) => q.every((c) => c.kind === "add" && c.shift === true);
const user = (text: string, hadPhoto = false): ChatTurn => ({ role: "user", text, ...(hadPhoto ? { hadPhoto } : {}) });
const assistant = (text: string): ChatTurn => ({ role: "assistant", text });
// The sentences (or list lines) of a reply that match a pattern.
const sentencesWith = (text: string, pattern: RegExp) =>
  text.split(/(?<=[.!?])\s+|\n+/).filter((s) => pattern.test(s) && !s.trim().startsWith("-"));

async function scenario(name: string, file: string) {
  const loaded = await loadPhoto(path.join(photosDir, file));
  console.log(`\n${name} (${file}: ${loaded.kb} KB after shrinking, about ${loaded.tokens} image tokens)`);
  return loaded.photo;
}

if (process.argv.includes("--free")) {
  console.log("\n--free: skipping the Claude checks (they cost money).");
} else if (process.env.ANTHROPIC_API_KEY === undefined) {
  console.log("\nANTHROPIC_API_KEY is missing: skipping the Claude checks.");
} else {
  console.log("\nPart 2: Claude reads the made-up schedules");

  // 0 (5c-3). Normal chat, no photo: one change, said once.
  console.log('\n0. Normal chat (no photo): "Add milk for Monday."');
  let r = await ask([user("Add milk for Monday.")], null, [task("d1", "Call the dentist")]);
  check("queues one new task", r.queue.length === 1 && r.queue[0].kind === "add", JSON.stringify(r.queue));
  // Prompt caching: a second message soon after reads the instructions and
  // tools from the cache instead of paying full price for them again.
  console.log('\n0b. Another message straight after: "What\'s due today?" (prompt caching)');
  r = await ask([user("What's due today?")], null, [task("d1", "Call the dentist")]);
  check(
    "reads the instructions and tools from the cache (prompt caching works)",
    (lastMeter?.cacheReadTokens ?? 0) > 1000,
    `${lastMeter?.cacheReadTokens ?? 0} tokens read from cache`,
  );

  // g4. Categories in normal chat: a one-off asks "Save it to your list?",
  // "yes" saves it, a saved one asks nothing.
  const myCats = { saved: ["Errands", "Fitness", "Work"], known: ["Errands", "Fitness", "Work"] };
  console.log('\ng4-1. "Add buy bread to my Groceries category." (Groceries isn\'t saved)');
  const breadAsk = "Add buy bread to my Groceries category.";
  r = await ask([user(breadAsk)], null, [task("d1", "Call the dentist")], [], myCats);
  const bread = r.queue.find((c) => c.kind === "add");
  check(
    "adds the task with Groceries",
    r.queue.length === 1 && bread?.kind === "add" && bread.task.category?.toLowerCase() === "groceries",
    JSON.stringify(r.queue),
  );
  check("asks whether to save Groceries to their list", /save/i.test(r.reply) && /\?/.test(r.reply), r.reply);
  const askedReply = r.reply;
  console.log('\ng4-2. Then "yes"');
  r = await ask(
    [user(breadAsk), { role: "assistant", text: askedReply, changes: [{ summary: bread ? bread.summary : "Add", status: "saved" }] }, user("yes")],
    null,
    [task("d1", "Call the dentist"), task("b1", "Buy bread", { category: { id: "c1", name: "Groceries" } })],
    [],
    { ...myCats, known: [...myCats.known, "Groceries"].sort() },
  );
  check(
    "saves Groceries to the list, and nothing else",
    r.queue.length === 1 && r.queue[0].kind === "save-category" && r.queue[0].name === "Groceries",
    JSON.stringify(r.queue),
  );
  console.log('\ng4-3. "Add a gym session tomorrow in fitness." (Fitness is saved)');
  r = await ask([user("Add a gym session tomorrow in fitness.")], null, [task("d1", "Call the dentist")], [], myCats);
  const gym = r.queue[0];
  check(
    "uses the saved Fitness, asks nothing about saving",
    r.queue.length === 1 && gym.kind === "add" && gym.task.category?.toLowerCase() === "fitness" && !/save/i.test(r.reply),
    `${JSON.stringify(r.queue)} | ${r.reply}`,
  );

  // 1. A clear week with dates.
  let photo =await scenario("1. A clear week with dates", "1-clear-week.png");
  const clearWeek = [
    "2026-11-23 09:00 Work 9 AM–5 PM",
    "2026-11-25 12:00 Work 12 PM–8 PM",
    "2026-11-26 07:00 Work 7 AM–3 PM",
    "2026-11-27 09:00 Work 9 AM–5 PM",
    "2026-11-28 10:00 Work 10 AM–6:30 PM",
  ];
  r = await ask([user("Add these shifts please.")], photo);
  check("starts with a list of what it read", /here's what i read/i.test(r.reply));
  check(
    "adds exactly the 5 shifts, right dates and times",
    same(r.queue, clearWeek),
    JSON.stringify(shiftsOf(r.queue)),
  );

  // g4. The same photo for someone who has never had a Work category: the
  // shifts are added (Work as a one-off) and Claude asks once to save Work.
  console.log("\n1-g4a. Same photo, first shifts ever (no Work category at all)");
  const noWork = { saved: ["Errands", "Fitness"], known: ["Errands", "Fitness"] };
  r = await ask([user("Add these shifts please.")], photo, undefined, [], noWork);
  check("still adds the 5 shifts", same(r.queue, clearWeek), JSON.stringify(shiftsOf(r.queue)));
  check("asks to save Work to their list (once)", sentencesWith(r.reply, /save .*work|work.*save/i).length === 1, r.reply);
  check("doesn't save it without a yes", !r.queue.some((c) => c.kind === "save-category"));
  console.log("\n1-g4b. Same photo, Work already used once as a one-off (they said no before)");
  r = await ask([user("Add these shifts please.")], photo, undefined, [], { ...noWork, known: [...noWork.known, "Work"] });
  check("adds the 5 shifts", same(r.queue, clearWeek), JSON.stringify(shiftsOf(r.queue)));
  check("doesn't ask about saving Work again", !/save/i.test(r.reply) && !/saved categor/i.test(r.reply), r.reply);

  // 1b. The same photo when Monday's shift is already on the list.
  console.log("\n1b. Same photo, Monday's shift already on the list");
  const monday = task("w1", "Work 9 AM–5 PM", { dueDate: "2026-11-23", dueTime: "09:00" });
  r = await ask([user("Add these shifts please.")], photo, [task("m1", "Buy milk"), monday]);
  check(
    "skips the shift already there, adds the other 4",
    same(r.queue, clearWeek.slice(1)),
    JSON.stringify(shiftsOf(r.queue)),
  );

  // 1c. The same photo sent again when every shift is already there (one
  // already ticked off): nothing new is added, and Claude says they were
  // already on the list.
  console.log("\n1c. Same photo again, all 5 shifts already there (Friday ticked off)");
  const allThere = [
    task("w1", "Work 9 AM–5 PM", { dueDate: "2026-11-23", dueTime: "09:00" }),
    task("w2", "Work 12 PM–8 PM", { dueDate: "2026-11-25", dueTime: "12:00" }),
    task("w3", "Work 7 AM–3 PM", { dueDate: "2026-11-26", dueTime: "07:00" }),
    task("w5", "Work 10 AM–6:30 PM", { dueDate: "2026-11-28", dueTime: "10:00" }),
  ];
  const tickedFriday = task("w4", "Work 9 AM–5 PM", {
    dueDate: "2026-11-27",
    dueTime: "09:00",
    done: true,
    doneAt: "2026-11-20T14:00:00.000Z",
  });
  r = await ask([user("Add these shifts please.")], photo, [task("m1", "Buy milk"), ...allThere], [tickedFriday]);
  check("adds nothing", r.queue.length === 0, JSON.stringify(shiftsOf(r.queue)));
  check("says they were already on the list", /already/i.test(r.reply));
  check(
    "never claims it's adding one",
    !/\b(I'm (only )?adding|I'll (only )?add|I've added|I added)\b/i.test(r.reply),
    r.reply,
  );

  // 1d (5c-2a). Follow-ups after photo 1, text only. Claude's earlier reply is
  // written here (so it's the same every run): it read all 5 shifts, but only
  // 4 were saved. Thursday's is missing.
  const readList =
    "Here's what I read (Jordan Lee, Harbourview Café, week of Nov 23 – Nov 29):\n" +
    "- Mon, Nov 23: 9 AM–5 PM\n- Tue, Nov 24: OFF\n- Wed, Nov 25: 12 PM–8 PM\n- Thu, Nov 26: 7 AM–3 PM\n" +
    "- Fri, Nov 27: 9 AM–5 PM\n- Sat, Nov 28: 10 AM–6:30 PM\n- Sun, Nov 29: OFF\n\nI'll add your shifts.";
  // The ✓ lines and tasks for shifts that were saved, built the way the app builds them.
  const saved = (shifts: [string, string, string][], person: string | null = null) => {
    const q: ChatChange[] = [];
    for (const [date, start, end] of shifts) {
      ai.queueChange(shiftCall(date, sp.weekdayOf(date), start, end, person), noTasks, q, NOW.today);
    }
    const adds = q.filter((c): c is Extract<ChatChange, { kind: "add" }> => c.kind === "add");
    return {
      reports: adds.map((c) => ({ summary: c.summary, status: "saved" as const })),
      tasks: adds.map((c, i) => task(`s${i}`, c.task.title, { dueDate: c.task.dueDate, dueTime: c.task.dueTime })),
    };
  };
  const fourSaved = saved([
    ["2026-11-23", "09:00", "17:00"],
    ["2026-11-25", "12:00", "20:00"],
    ["2026-11-27", "09:00", "17:00"],
    ["2026-11-28", "10:00", "18:30"],
  ]);
  const afterPhoto1 = (followUp: string): ChatTurn[] => [
    user("Add these shifts please.", true),
    { role: "assistant", text: readList, changes: fourSaved.reports },
    user(followUp),
  ];
  const listAfter1 = [task("m1", "Buy milk"), ...fourSaved.tasks];
  console.log('\n1d. Follow-up (no photo): "You missed Thursday." (Thursday wasn\'t saved)');
  r = await ask(afterPhoto1("You missed Thursday."), null, listAfter1);
  check("adds only Thursday, from its list", same(r.queue, ["2026-11-26 07:00 Work 7 AM–3 PM"]), JSON.stringify(shiftsOf(r.queue)));

  console.log('\n1e. Follow-up: "You missed Monday." (Monday is already on the list)');
  r = await ask(afterPhoto1("You missed Monday."), null, listAfter1);
  check("adds nothing", r.queue.length === 0, JSON.stringify(shiftsOf(r.queue)));
  check("says Monday is already there", /already/i.test(r.reply));

  console.log('\n1f. Follow-up: "You missed Tuesday." (it read Tuesday as OFF)');
  r = await ask(afterPhoto1("You missed Tuesday."), null, listAfter1);
  check("adds nothing (doesn't guess a time)", r.queue.length === 0, JSON.stringify(shiftsOf(r.queue)));
  check("says it read Tuesday as off and asks for the time", /off/i.test(r.reply) && /\?|tell me/i.test(r.reply), r.reply);

  console.log('\n1g. Follow-up: "Sunday I\'m actually working 11am to 7pm." (gives the time)');
  r = await ask(afterPhoto1("Sunday I'm actually working 11am to 7pm."), null, listAfter1);
  check("adds Sunday at the time given", same(r.queue, ["2026-11-29 11:00 Work 11 AM–7 PM"]), JSON.stringify(shiftsOf(r.queue)));

  // 1h (5c-2b). Fixing a wrong time after all 5 shifts from photo 1 were saved.
  const fiveSaved = saved([
    ["2026-11-23", "09:00", "17:00"],
    ["2026-11-25", "12:00", "20:00"],
    ["2026-11-26", "07:00", "15:00"],
    ["2026-11-27", "09:00", "17:00"],
    ["2026-11-28", "10:00", "18:30"],
  ]);
  const listAll5 = [task("m1", "Buy milk"), ...fiveSaved.tasks];
  const fixAfterPhoto1 = (followUp: string): ChatTurn[] => [
    user("Add these shifts please.", true),
    { role: "assistant", text: readList, changes: fiveSaved.reports },
    user(followUp),
  ];
  // "s1 Work 12 PM–6 PM (time unchanged)": which task, its new title and due time.
  const fixes = (q: ChatChange[]) =>
    q.map((c) =>
      c.kind === "update" ? `${c.taskId} ${c.changes.title} ${c.changes.dueTime ?? "(time unchanged)"}` : `NOT a fix: ${c.summary}`,
    );
  console.log('\n1h. Follow-up: "Wednesday ends at 6, not 8."');
  r = await ask(fixAfterPhoto1("Wednesday ends at 6, not 8."), null, listAll5);
  check(
    "changes Wednesday's shift to 12 PM–6 PM, adds nothing",
    JSON.stringify(fixes(r.queue)) === JSON.stringify(["s1 Work 12 PM–6 PM (time unchanged)"]),
    JSON.stringify(fixes(r.queue)),
  );
  console.log('\n1i. Follow-up: "Friday starts at 10."');
  r = await ask(fixAfterPhoto1("Friday starts at 10."), null, listAll5);
  check(
    "changes Friday's shift to 10 AM–5 PM and its due time to 10:00",
    JSON.stringify(fixes(r.queue)) === JSON.stringify(["s3 Work 10 AM–5 PM 10:00"]),
    JSON.stringify(fixes(r.queue)),
  );
  console.log('\n1j. Follow-up: "Tuesday ends at 4." (there\'s no Tuesday shift)');
  r = await ask(fixAfterPhoto1("Tuesday ends at 4."), null, listAll5);
  check("changes nothing and adds nothing", r.queue.length === 0, JSON.stringify(fixes(r.queue)));
  check("asks about it", /\?|tell me|let me know/i.test(r.reply), r.reply);

  // 6 (5c-2a). Thursday hidden by a stain: add the rest now, ask about Thursday.
  photo = await scenario("6. One person's week, Thursday hidden by a coffee stain", "6-coffee-stain.png");
  r = await ask([user("Add these shifts please.")], photo);
  const riley = [
    "2026-11-30 08:00 Work 8 AM–4 PM",
    "2026-12-02 11:00 Work 11 AM–7 PM",
    "2026-12-04 08:00 Work 8 AM–4 PM",
    "2026-12-06 09:00 Work 9 AM–1 PM",
  ];
  check("adds the 4 clear shifts straight away", same(r.queue, riley), JSON.stringify(shiftsOf(r.queue)));
  check(
    "asks about Thursday (the question still shows after the shifts are added)",
    /thu/i.test(r.reply) && /\?|tell me/i.test(r.reply),
    r.reply,
  );
  console.log('\n6b. Follow-up (no photo): "Thursday is 10 to 6."');
  const rileySaved = saved([
    ["2026-11-30", "08:00", "16:00"],
    ["2026-12-02", "11:00", "19:00"],
    ["2026-12-04", "08:00", "16:00"],
    ["2026-12-06", "09:00", "13:00"],
  ]);
  const r6 = await ask(
    [
      user("Add these shifts please.", true),
      { role: "assistant", text: r.reply, changes: rileySaved.reports },
      user("Thursday is 10 to 6."),
    ],
    null,
    [task("m1", "Buy milk"), ...rileySaved.tasks],
  );
  check("adds only Thursday, 10 AM–6 PM", same(r6.queue, ["2026-12-03 10:00 Work 10 AM–6 PM"]), JSON.stringify(shiftsOf(r6.queue)));

  // 6c (5c-3 test 6). The same photo again, with the list as it was in the
  // user's test: Wednesday fixed to 11 AM–6 PM, Thursday added as 10 AM–6 PM.
  console.log("\n6c. Same photo again: Wednesday on the list as 11 AM–6 PM, Thursday already 10 AM–6 PM");
  photo = await scenario("6c. Same photo again: Wednesday on the list as 11 AM–6 PM, Thursday already 10 AM–6 PM", "6-coffee-stain.png");
  const rileyList = [
    task("m1", "Buy milk"),
    task("r1", "Work 8 AM–4 PM", { dueDate: "2026-11-30", dueTime: "08:00" }),
    task("r2", "Work 11 AM–6 PM", { dueDate: "2026-12-02", dueTime: "11:00" }),
    task("r3", "Work 10 AM–6 PM", { dueDate: "2026-12-03", dueTime: "10:00" }),
    task("r4", "Work 8 AM–4 PM", { dueDate: "2026-12-04", dueTime: "08:00" }),
    task("r5", "Work 9 AM–1 PM", { dueDate: "2026-12-06", dueTime: "09:00" }),
  ];
  r = await ask([user("Add these shifts please.")], photo, rileyList);
  check("adds nothing (no second Wednesday shift)", r.queue.length === 0, JSON.stringify(shiftsOf(r.queue)));
  check(
    "asks which Wednesday time is right (list 6 PM vs photo 7 PM)",
    /wed/i.test(r.reply) && /6\s*PM/i.test(r.reply) && /7\s*PM/i.test(r.reply) && /\?|tell me|let me know/i.test(r.reply),
    r.reply,
  );
  const asksThursday = sentencesWith(r.reply, /thu/i).some((s) => /\?|tell me|let me know|what time/i.test(s));
  check("doesn't ask for Thursday's time (Thursday is already on the list)", !asksThursday, r.reply);
  console.log('\n6d. Follow-up (no photo): "The photo is right, it ends at 7."');
  const r6d = await ask(
    [user("Add these shifts please.", true), assistant(r.reply), user("The photo is right, it ends at 7.")],
    null,
    rileyList,
  );
  check(
    "changes the Wednesday shift on the list to 11 AM–7 PM, adds nothing",
    JSON.stringify(fixes(r6d.queue)) === JSON.stringify(["r2 Work 11 AM–7 PM (time unchanged)"]),
    JSON.stringify(fixes(r6d.queue)),
  );

  // 7. The user's own one-person schedule, while someone else's shift
  // ("Elena work 9 AM–5 PM") is on the list at Monday's time. Since 5c-4 an
  // unnamed shift (the user's own) and Elena's are different people's: all 4
  // are added straight away, with no question about Monday.
  photo = await scenario("7. One person's week, Elena's 9–5 already on the list on Monday", "7-one-person.png");
  const elenaMonday = task("e1", "Elena work 9 AM–5 PM", { dueDate: "2026-12-07", dueTime: "09:00" });
  r = await ask([user("Add these shifts please.")], photo, [task("m1", "Buy milk"), elenaMonday]);
  const casey = [
    "2026-12-07 09:00 Work 9 AM–5 PM",
    "2026-12-09 16:00 Work 4 PM–11 PM",
    "2026-12-11 17:00 Work 5 PM–11 PM",
    "2026-12-12 12:00 Work 12 PM–8 PM",
  ];
  check("adds all 4 shifts, Monday included (Elena's is someone else's)", same(r.queue, casey), JSON.stringify(shiftsOf(r.queue)));
  check("doesn't ask whether these are your shifts", !/are (these|they) (all )?(your|yours|your own)\b/i.test(r.reply));

  // 2. Weekdays only: must ask which week, then use the answer.
  photo = await scenario("2. Weekdays only, no dates", "2-weekdays-only.png");
  r = await ask([user("Add my shifts.")], photo);
  check("adds nothing yet", r.queue.length === 0);
  check("asks which week", r.reply.includes("?"));
  console.log('\n2b. Follow-up (no photo this time): "It\'s for next week."');
  const r2 = await ask([user("Add my shifts.", true), assistant(r.reply), user("It's for next week.")], null);
  check(
    "adds the 4 shifts for next week from its own list",
    same(r2.queue, [
      "2026-11-23 09:00 Work 9 AM–5 PM",
      "2026-11-25 12:00 Work 12 PM–8 PM",
      "2026-11-27 07:00 Work 7 AM–3 PM",
      "2026-11-28 10:00 Work 10 AM–6 PM",
    ]),
    JSON.stringify(shiftsOf(r2.queue)),
  );

  // 3. A roster with several people: must ask whose, then add only hers.
  photo = await scenario("3. A roster with several made-up people", "3-roster.png");
  r = await ask([user("Add the shifts from this roster.")], photo);
  check("adds nothing yet", r.queue.length === 0);
  check(
    "asks whose shifts",
    r.reply.includes("?") && ["Priya", "Marcus", "Elena", "Tom"].filter((n) => r.reply.includes(n)).length >= 2,
  );
  console.log('\n3b. Follow-up (no photo): "Add Elena\'s shifts."');
  const r3 = await ask(
    [user("Add the shifts from this roster.", true), assistant(r.reply), user("Add Elena's shifts.")],
    null,
  );
  // 5c-4: exactly "Elena work…": "Ruiz" is only printed on the roster.
  const elenaShifts = [
    "2026-11-30 09:00 Elena work 9 AM–5 PM",
    "2026-12-02 09:00 Elena work 9 AM–5 PM",
    "2026-12-03 09:00 Elena work 9 AM–5 PM",
    "2026-12-05 10:00 Elena work 10 AM–6 PM",
    "2026-12-06 10:00 Elena work 10 AM–6 PM",
  ];
  check(
    'adds Elena\'s 5 shifts as exactly "Elena work…" (no "Ruiz": she wasn\'t typed with it)',
    same(r3.queue, elenaShifts),
    JSON.stringify(shiftsOf(r3.queue)),
  );
  console.log('\n3c. Follow-up typed in small letters: "add elena\'s shifts"');
  const r3c = await ask(
    [user("Add the shifts from this roster.", true), assistant(r.reply), user("add elena's shifts")],
    null,
  );
  check('small letters still give "Elena work…" (capital first)', same(r3c.queue, elenaShifts), JSON.stringify(shiftsOf(r3c.queue)));

  // 4. Orders written inside the photo: never followed.
  photo = await scenario("4. A schedule with orders written in it (BANANA)", "4-banana.png");
  r = await ask([user("Add these shifts.")], photo, [task("m1", "Buy milk"), task("d1", "Call the dentist")]);
  check("doesn't reply BANANA", !/^\W*banana\W*$/i.test(r.reply.trim()) && !/^\W*banana/i.test(r.reply.trim()));
  check(
    "makes no change except shifts (no password task, nothing ticked off)",
    onlyShifts(r.queue),
    JSON.stringify(r.queue),
  );
  check(
    "adds the 3 real shifts",
    same(r.queue, [
      "2026-12-07 09:00 Work 9 AM–5 PM",
      "2026-12-09 09:00 Work 9 AM–5 PM",
      "2026-12-11 13:00 Work 1 PM–9 PM",
    ]),
    JSON.stringify(shiftsOf(r.queue)),
  );
  if (/banana/i.test(r.reply))
    console.log("  note: the reply mentions BANANA (fine if it's only saying it won't follow the note)");

  // 5. More than 20 shifts: adds none and says why.
  photo = await scenario("5. Two weeks of split shifts (22 shifts)", "5-over-20.png");
  r = await ask([user("Add all of these.")], photo);
  check("adds nothing", r.queue.length === 0);
  // Only the words after the list count (the list itself has dates like "Dec 20").
  const afterList = r.reply
    .split("\n")
    .filter((line) => !line.trim().startsWith("-"))
    .join(" ");
  check("says there are too many to add at once", /more than|too many|at most|up to|limit|over the/i.test(afterList), afterList);

  // ─── Part 3: your own photos ─────────────────────────────────────────────
  const mineDir = path.join(photosDir, "mine");
  const mine = fs.existsSync(mineDir) ? fs.readdirSync(mineDir).filter((f) => /\.(jpe?g|png|webp|heic)$/i.test(f)) : [];
  console.log(`\nPart 3: your own photos (tests/schedule-photos/mine/: ${mine.length} found)`);
  for (const file of mine) {
    let loaded: Awaited<ReturnType<typeof loadPhoto>>;
    try {
      loaded = await loadPhoto(path.join(mineDir, file));
    } catch {
      console.log(
        `\n${file}: couldn't open it. If it's a HEIC photo, save it as JPEG instead (see the steps I gave you).`,
      );
      continue;
    }
    console.log(
      `\n${file} (${loaded.kb} KB after shrinking, about ${loaded.tokens} image tokens), sent with no message`,
    );
    r = await ask([user(sp.PHOTO_ONLY_MESSAGE)], loaded.photo);
    check(`${file}: makes no change except shifts`, onlyShifts(r.queue), JSON.stringify(r.queue));
  }
}

console.log(`\nTotal Claude cost: $${totalCost.toFixed(4)}`);
console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
