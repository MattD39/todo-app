//
// Checks deleting several tasks at once (Edit mode on Today, Upcoming, Done).
//
// Run with: npm run check:batch-delete
//
// Free: no Claude calls. Runs the real server code (src/lib/tasks.ts) for a
// MADE-UP test user (not you), with the database's own privacy rules on:
//   - whole tasks are deleted and each one lands in Recently deleted, with
//     its steps, notes and history, exactly like swipe to delete;
//   - a "Finished today" entry deletes only that entry; one whose task is in
//     the same batch goes with its task;
//   - rows already gone, or belonging to someone else, are skipped (and a
//     second made-up person's task is never touched);
//   - at most 200 at once, and 200 goes through quickly;
//   - bad input and a signed-out visitor change nothing;
//   - Undo (part d) brings a whole batch back, with everything in it, and
//     copes with tasks already restored or deleted forever meanwhile;
//   - the Done tab (part e) lists each tick of a repeating task as its own
//     entry, newest first, and marks which one is the latest.
// Only the two made-up people's rows are created and deleted (at the start
// and the end); your own tasks are never touched or shown. Exits with an
// error if any check fails.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "server-only": path.join(root, "scripts/server-only-stub.cjs"),
    "@/": path.join(root, "src") + path.sep,
  },
});
const tasks = await jiti.import<typeof import("../src/lib/tasks.ts")>(path.join(root, "src/lib/tasks.ts"));
const auth = await jiti.import<typeof import("../src/lib/auth.ts")>(path.join(root, "src/lib/auth.ts"));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `\n      ${detail}` : ""}`);
}

const TEST_USER = "00000000-0000-4000-8000-0000000b0001"; // nobody real
const OTHER_USER = "00000000-0000-4000-8000-0000000b0002"; // a second made-up person
const asTestUser = <T,>(work: () => Promise<T>) =>
  auth.runAsVerifiedUser({ id: TEST_USER, email: null, timeZone: "America/Halifax" }, work);

const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
await owner.connect();

async function cleanUp() {
  for (const user of [TEST_USER, OTHER_USER]) {
    await owner.query(`DELETE FROM "Task" WHERE "userId" = $1`, [user]);
    await owner.query(`DELETE FROM "RecentlyDeleted" WHERE "userId" = $1`, [user]);
    await owner.query(`DELETE FROM "Category" WHERE "userId" = $1`, [user]);
  }
}

// Adds a task for `user` as the database owner and returns its id.
async function addTask(user: string, title: string, extra: { notes?: string; repeat?: string } = {}): Promise<string> {
  const { rows } = await owner.query(
    `INSERT INTO "Task" (id, "userId", title, notes, repeat, "dueDate", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4::"Repeat", $5::date, now()) RETURNING id`,
    [user, title, extra.notes ?? "", extra.repeat ?? null, extra.repeat ? "2026-12-01" : null],
  );
  return rows[0].id;
}
async function addStep(taskId: string, title: string, position: number) {
  await owner.query(`INSERT INTO "Subtask" (id, "taskId", title, position) VALUES (gen_random_uuid(), $1, $2, $3)`, [
    taskId,
    title,
    position,
  ]);
}
// ago: when it was ticked, like "1 hour" (default: now).
async function addTick(taskId: string, completedOn: string, ago = "0 seconds"): Promise<string> {
  const { rows } = await owner.query(
    `INSERT INTO "TaskCompletion" (id, "taskId", "completedOn", "createdAt")
     VALUES (gen_random_uuid(), $1, $2::date, now() - $3::interval) RETURNING id`,
    [taskId, completedOn, ago],
  );
  return rows[0].id;
}
const exists = async (table: string, id: string) =>
  (await owner.query(`SELECT 1 FROM "${table}" WHERE id = $1`, [id])).rowCount === 1;
const binCopy = async (id: string) =>
  (await owner.query(`SELECT copy FROM "RecentlyDeleted" WHERE id = $1 AND "userId" = $2`, [id, TEST_USER])).rows[0]
    ?.copy as Record<string, unknown> | undefined;

// The error message a call fails with, or null if it worked.
async function errorOf(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

try {
  await cleanUp();
  console.log("\nDeleting several at once, for a made-up test user (cleaned up afterwards)\n");

  // 1. Two plain tasks.
  const a = await addTask(TEST_USER, "Batch A");
  const b = await addTask(TEST_USER, "Batch B");
  let r = await asTestUser(() => tasks.deleteManyWithCopies([{ taskId: a }, { taskId: b }]));
  check("two tasks: both deleted", r.tasks === 2 && r.entries === 0 && r.missing === 0, JSON.stringify(r));
  check("…and gone from the list", !(await exists("Task", a)) && !(await exists("Task", b)));
  check(
    "…and both are in Recently deleted",
    (await binCopy(a))?.title === "Batch A" && (await binCopy(b))?.title === "Batch B",
  );
  check("the result has their ids (for Undo)", [...r.taskIds].sort().join() === [a, b].sort().join());

  // 2. A task with steps and notes keeps them in its copy.
  const c = await addTask(TEST_USER, "Batch C", { notes: "Bring the forms" });
  await addStep(c, "Find the forms", 0);
  await addStep(c, "Sign them", 1);
  await asTestUser(() => tasks.deleteManyWithCopies([{ taskId: c }]));
  const cCopy = await binCopy(c);
  const steps = (cCopy?.steps as { title: string }[] | undefined)?.map((s) => s.title) ?? [];
  check(
    "a task's copy in Recently deleted keeps its notes and steps, in order",
    cCopy?.notes === "Bring the forms" && steps.join("|") === "Find the forms|Sign them",
    JSON.stringify(cCopy),
  );

  // 3. One "Finished today" entry of a repeating task: only that entry goes.
  const rep = await addTask(TEST_USER, "Batch gym", { repeat: "daily" });
  const tick1 = await addTick(rep, "2026-11-22");
  const tick2 = await addTick(rep, "2026-11-23");
  r = await asTestUser(() => tasks.deleteManyWithCopies([{ completionId: tick2 }]));
  check("one entry: counted as an entry, not a task", r.tasks === 0 && r.entries === 1, JSON.stringify(r));
  check(
    "…only that entry is gone; the task and its other entry stay",
    !(await exists("TaskCompletion", tick2)) && (await exists("Task", rep)) && (await exists("TaskCompletion", tick1)),
  );
  check("…an entry isn't put in Recently deleted (same as swiping one)", (await binCopy(rep)) === undefined);
  check("…the result has the entry's copy (for Undo)", r.ticks.length === 1 && r.ticks[0].id === tick2);

  // 4. The task and its own entry in one batch: the entry goes with the task.
  r = await asTestUser(() => tasks.deleteManyWithCopies([{ completionId: tick1 }, { taskId: rep }]));
  check("task + its own entry: one task, no separate entry, none missing", r.tasks === 1 && r.entries === 0 && r.missing === 0, JSON.stringify(r));
  const repCopy = await binCopy(rep);
  check(
    "…the task's copy keeps that entry in its history",
    (repCopy?.ticks as { id: string }[] | undefined)?.some((t) => t.id === tick1) === true,
    JSON.stringify(repCopy?.ticks),
  );

  // 5. Already gone: skipped and counted.
  const d = await addTask(TEST_USER, "Batch D");
  r = await asTestUser(() => tasks.deleteManyWithCopies([{ taskId: a }, { taskId: d }]));
  check("one already deleted + one new: 1 deleted, 1 already gone", r.tasks === 1 && r.missing === 1, JSON.stringify(r));

  // 6. Someone else's task, even with its real id: skipped, untouched.
  const theirs = await addTask(OTHER_USER, "Someone else's task");
  r = await asTestUser(() => tasks.deleteManyWithCopies([{ taskId: theirs }]));
  check("someone else's task: nothing deleted, counted as gone", r.tasks === 0 && r.missing === 1, JSON.stringify(r));
  check(
    "…it's still there and not in anyone's Recently deleted",
    (await exists("Task", theirs)) && (await exists("RecentlyDeleted", theirs)) === false,
  );

  // 7. Limits and bad input change nothing.
  const e = await addTask(TEST_USER, "Batch E");
  const tooMany = Array.from({ length: 201 }, () => ({ taskId: e }));
  check(
    "201 at once is refused",
    (await errorOf(() => asTestUser(() => tasks.deleteManyWithCopies(tooMany))))?.includes("up to 200") === true,
  );
  check("nothing selected is refused", (await errorOf(() => asTestUser(() => tasks.deleteManyWithCopies([])))) !== null);
  check(
    "a made-up id format is refused, and nothing else in the batch is deleted",
    (await errorOf(() => asTestUser(() => tasks.deleteManyWithCopies([{ taskId: e }, { taskId: "not-an-id" }])))) !==
      null && (await exists("Task", e)),
  );
  check(
    "a signed-out visitor can't delete anything",
    (await errorOf(() => tasks.deleteManyWithCopies([{ taskId: e }]))) !== null && (await exists("Task", e)),
  );

  // 8. 200 at once goes through quickly, all into Recently deleted.
  const { rows: many } = await owner.query(
    `INSERT INTO "Task" (id, "userId", title, "updatedAt")
     SELECT gen_random_uuid(), $1, 'Batch bulk ' || n, now() FROM generate_series(1, 200) AS n RETURNING id`,
    [TEST_USER],
  );
  const started = Date.now();
  r = await asTestUser(() => tasks.deleteManyWithCopies(many.map((row) => ({ taskId: row.id }))));
  const seconds = (Date.now() - started) / 1000;
  const { rows: binned } = await owner.query(
    `SELECT count(*)::int AS n FROM "RecentlyDeleted" WHERE "userId" = $1 AND copy->>'title' LIKE 'Batch bulk %'`,
    [TEST_USER],
  );
  check(`200 at once: all deleted (took ${seconds.toFixed(1)}s)`, r.tasks === 200 && seconds < 4, JSON.stringify({ ...r, taskIds: r.taskIds.length }));
  check("…and all 200 are in Recently deleted", binned[0].n === 200, `${binned[0].n} found`);

  // ── Undo (part d) ──
  console.log("\nUndo after a batch delete\n");

  // 9. Undo the 200: all back quickly, and out of Recently deleted.
  const undoStarted = Date.now();
  let u = await asTestUser(() => tasks.restoreBatch({ taskIds: r.taskIds, ticks: r.ticks }));
  const undoSeconds = (Date.now() - undoStarted) / 1000;
  const { rows: back } = await owner.query(
    `SELECT count(*)::int AS n FROM "Task" WHERE "userId" = $1 AND title LIKE 'Batch bulk %'`,
    [TEST_USER],
  );
  const { rows: stillBinned } = await owner.query(
    `SELECT count(*)::int AS n FROM "RecentlyDeleted" WHERE "userId" = $1 AND copy->>'title' LIKE 'Batch bulk %'`,
    [TEST_USER],
  );
  check(
    `undo 200: all back (took ${undoSeconds.toFixed(1)}s)`,
    u.restored === 200 && u.alreadyBack === 0 && u.failed === 0 && back[0].n === 200 && undoSeconds < 4,
    JSON.stringify(u),
  );
  check("…and none left in Recently deleted", stillBinned[0].n === 0, `${stillBinned[0].n} left`);

  // 10. Everything about a task comes back: notes, steps, category, history.
  const full = await addTask(TEST_USER, "Batch full", { notes: "Keep the receipt", repeat: "weekly" });
  await addStep(full, "Step one", 0);
  await addStep(full, "Step two", 1);
  const fullTick = await addTick(full, "2026-11-20");
  const { rows: cat } = await owner.query(
    `INSERT INTO "Category" (id, "userId", name) VALUES (gen_random_uuid(), $1, 'Batch errands') RETURNING id`,
    [TEST_USER],
  );
  await owner.query(`UPDATE "Task" SET "categoryId" = $1 WHERE id = $2`, [cat[0].id, full]);
  const plain = await addTask(TEST_USER, "Batch plain");
  r = await asTestUser(() => tasks.deleteManyWithCopies([{ taskId: full }, { taskId: plain }]));
  u = await asTestUser(() => tasks.restoreBatch({ taskIds: r.taskIds, ticks: r.ticks }));
  const { rows: fullBack } = await owner.query(
    `SELECT t.notes, t.repeat, c.name AS category,
       (SELECT string_agg(title, '|' ORDER BY position) FROM "Subtask" WHERE "taskId" = t.id) AS steps,
       (SELECT count(*)::int FROM "TaskCompletion" WHERE id = $2) AS tick
     FROM "Task" t LEFT JOIN "Category" c ON c.id = t."categoryId" WHERE t.id = $1`,
    [full, fullTick],
  );
  check("undo 2 tasks: both back", u.restored === 2 && (await exists("Task", plain)), JSON.stringify(u));
  check(
    "…with notes, repeat, steps in order, category and history",
    fullBack[0]?.notes === "Keep the receipt" &&
      fullBack[0]?.repeat === "weekly" &&
      fullBack[0]?.steps === "Step one|Step two" &&
      fullBack[0]?.category === "Batch errands" &&
      fullBack[0]?.tick === 1,
    JSON.stringify(fullBack[0]),
  );

  // 11. A single "Finished today" entry comes back to its task.
  const gym = await addTask(TEST_USER, "Batch gym 2", { repeat: "daily" });
  const gymTick = await addTick(gym, "2026-11-24");
  r = await asTestUser(() => tasks.deleteManyWithCopies([{ completionId: gymTick }]));
  u = await asTestUser(() => tasks.restoreBatch({ taskIds: r.taskIds, ticks: r.ticks }));
  check("undo an entry: it's back on its task", u.restored === 1 && (await exists("TaskCompletion", gymTick)), JSON.stringify(u));

  // 12. Restored from Settings before Undo: counted as already back, the rest still come back.
  const s1 = await addTask(TEST_USER, "Batch settings 1");
  const s2 = await addTask(TEST_USER, "Batch settings 2");
  r = await asTestUser(() => tasks.deleteManyWithCopies([{ taskId: s1 }, { taskId: s2 }]));
  await asTestUser(() => tasks.restoreFromBin(s1)); // as if restored from Settings → Recently deleted
  u = await asTestUser(() => tasks.restoreBatch({ taskIds: r.taskIds, ticks: r.ticks }));
  check(
    "one already restored from Settings: 1 restored, 1 already back",
    u.restored === 1 && u.alreadyBack === 1 && u.failed === 0 && (await exists("Task", s2)),
    JSON.stringify(u),
  );

  // 13. Deleted forever from Settings before Undo: can't come back, counted.
  const f1 = await addTask(TEST_USER, "Batch forever");
  r = await asTestUser(() => tasks.deleteManyWithCopies([{ taskId: f1 }]));
  await asTestUser(() => tasks.deleteFromBin(f1));
  u = await asTestUser(() => tasks.restoreBatch({ taskIds: r.taskIds, ticks: r.ticks }));
  check("deleted forever meanwhile: counted as couldn't come back", u.restored === 0 && u.failed === 1, JSON.stringify(u));

  // 14. Someone else's: Undo can't bring back (or touch) another person's task.
  const theirs2 = await addTask(OTHER_USER, "Someone else's binned task");
  await owner.query(
    `INSERT INTO "RecentlyDeleted" (id, "userId", copy) VALUES ($1::uuid, $2::uuid, jsonb_build_object('id', $3::text, 'title', 'Theirs'))`,
    [theirs2, OTHER_USER, theirs2],
  );
  await owner.query(`DELETE FROM "Task" WHERE id = $1`, [theirs2]); // now only in their Recently deleted
  u = await asTestUser(() => tasks.restoreBatch({ taskIds: [theirs2], ticks: [] }));
  check(
    "someone else's binned task: not restored, still in their Recently deleted",
    u.restored === 0 && !(await exists("Task", theirs2)) && (await exists("RecentlyDeleted", theirs2)),
    JSON.stringify(u),
  );

  // 15. Bad input changes nothing.
  check(
    "undo with nothing in it is refused",
    (await errorOf(() => asTestUser(() => tasks.restoreBatch({ taskIds: [], ticks: [] })))) !== null,
  );
  check(
    "undo with a made-up id format is refused",
    (await errorOf(() => asTestUser(() => tasks.restoreBatch({ taskIds: ["nope"], ticks: [] })))) !== null,
  );
  check(
    "undo by a signed-out visitor is refused",
    (await errorOf(() => tasks.restoreBatch({ taskIds: [s2], ticks: [] }))) !== null,
  );

  // ── The Done tab's list (part e) ──
  console.log("\nThe Done tab: repeating-task entries\n");
  await cleanUp(); // a clean slate, so the list holds only what's added here
  const finished = await addTask(TEST_USER, "Done plain");
  await owner.query(`UPDATE "Task" SET done = true, "doneAt" = now() - interval '2 hours' WHERE id = $1`, [finished]);
  const teeth = await addTask(TEST_USER, "Done brush teeth", { repeat: "daily" });
  const olderTick = await addTick(teeth, "2026-11-23", "3 hours");
  const newerTick = await addTick(teeth, "2026-11-24", "1 hour");
  const someoneElses = await addTask(OTHER_USER, "Done their repeat", { repeat: "daily" });
  await addTick(someoneElses, "2026-11-24", "1 hour");
  const list = await asTestUser(() => tasks.listDoneTasks(100));
  const shape = list.map((t) => `${t.title}${t.completionId ? ` [entry${"isLatest" in t && t.isLatest ? ", latest" : ""}]` : ""}`);
  check(
    "a repeating task's ticks show as their own entries, newest first, mixed with finished tasks",
    JSON.stringify(shape) ===
      JSON.stringify(["Done brush teeth [entry, latest]", "Done plain", "Done brush teeth [entry]"]),
    JSON.stringify(shape),
  );
  check(
    "each entry is its tick (so deleting it removes only that tick)",
    list[0].completionId === newerTick && list[2].completionId === olderTick,
  );
  check("someone else's ticks never show", !list.some((t) => t.title === "Done their repeat"));
  const two = await asTestUser(() => tasks.listDoneTasks(2));
  check("the limit counts entries and tasks together", two.length === 2, `${two.length} shown`);
} finally {
  await cleanUp();
  await owner.end();
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
