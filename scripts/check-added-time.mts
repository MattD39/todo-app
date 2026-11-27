//
// Checks each task's "added" time, which the list order uses (step 3 of the
// order: oldest added first; step 4: added at the same moment, A to Z).
//
// Run with: npm run check:added-time
//
// Free: no Claude calls. Runs the real server code (src/lib/tasks.ts and
// src/lib/chat-changes.ts) for a MADE-UP test user (not you), with the
// database's own privacy rules on:
//   - every task from one Chat reply gets the same added time, so "Shift 1,
//     Shift 2, Shift 10" sort in that order;
//   - a second reply, and each connector call, get their own times;
//   - the app's own Add button uses the time it was added;
//   - a task brought back keeps its original added time, however it comes
//     back: Restore (Recently deleted), Undo after a delete, Undo after a
//     batch delete, and Restore all.
// Only the made-up person's rows are created and deleted (at the start and
// the end); your own tasks are never touched or shown. Exits with an error if
// any check fails.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import pg from "pg";
import type { ChatChange } from "../src/lib/chat-changes.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "server-only": path.join(root, "scripts/server-only-stub.cjs"),
    "@/": path.join(root, "src") + path.sep,
  },
});
const tasks = await jiti.import<typeof import("../src/lib/tasks.ts")>(path.join(root, "src/lib/tasks.ts"));
const auth = await jiti.import<typeof import("../src/lib/auth.ts")>(path.join(root, "src/lib/auth.ts"));
const changes = await jiti.import<typeof import("../src/lib/chat-changes.ts")>(path.join(root, "src/lib/chat-changes.ts"));
const views = await jiti.import<typeof import("../src/lib/views.ts")>(path.join(root, "src/lib/views.ts"));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `\n      ${detail}` : ""}`);
}

const TEST_USER = "00000000-0000-4000-8000-0000000d0001"; // nobody real
const asTestUser = <T,>(work: () => Promise<T>) =>
  auth.runAsVerifiedUser({ id: TEST_USER, email: null, timeZone: "America/Halifax" }, work);

const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
await owner.connect();

async function cleanUp() {
  await owner.query(`DELETE FROM "Task" WHERE "userId" = $1`, [TEST_USER]);
  await owner.query(`DELETE FROM "RecentlyDeleted" WHERE "userId" = $1`, [TEST_USER]);
  await owner.query(`DELETE FROM "Category" WHERE "userId" = $1`, [TEST_USER]);
}

// The added time of each of the test user's tasks with these titles, read straight from the database.
async function addedTimes(titles: string[]): Promise<Map<string, string>> {
  const { rows } = await owner.query(
    `SELECT title, "createdAt" FROM "Task" WHERE "userId" = $1 AND title = ANY($2)`,
    [TEST_USER, titles],
  );
  return new Map(rows.map((r: { title: string; createdAt: Date }) => [r.title, r.createdAt.toISOString()]));
}

const add = (title: string): ChatChange => ({
  kind: "add",
  task: { title, dueDate: "2026-12-10" },
  summary: "",
});

const OLD = "2026-01-15T10:00:00.000Z"; // an added time long ago

try {
  await cleanUp();

  console.log("\nChat: one reply = one moment\n");
  const reply = await asTestUser(() => changes.applyChanges([add("Shift 10"), add("Shift 2"), add("Shift 1")]));
  check("all three saved", reply.every((r) => r.ok), JSON.stringify(reply));
  const shifts = await addedTimes(["Shift 10", "Shift 2", "Shift 1"]);
  check("all three have the same added time", new Set(shifts.values()).size === 1, JSON.stringify([...shifts]));
  const open = await asTestUser(() => tasks.listOpenTasks());
  const sorted = views.sortTasks(open.filter((t) => t.title.startsWith("Shift"))).map((t) => t.title);
  check(
    "so the list shows Shift 1, Shift 2, Shift 10",
    JSON.stringify(sorted) === JSON.stringify(["Shift 1", "Shift 2", "Shift 10"]),
    JSON.stringify(sorted),
  );
  check(
    "the screens get the added time too",
    open.every((t) => typeof t.createdAt === "string" && !Number.isNaN(Date.parse(t.createdAt))),
  );

  await new Promise((done) => setTimeout(done, 20));
  await asTestUser(() => changes.applyChanges([add("Next reply")]));
  const next = await addedTimes(["Next reply"]);
  check("a later reply gets its own, later time", next.get("Next reply")! > shifts.get("Shift 1")!);

  console.log("\nThe connector: each call its own time\n");
  await asTestUser(() => changes.applyChanges([add("Connector A")]));
  await new Promise((done) => setTimeout(done, 20));
  await asTestUser(() => changes.applyChanges([add("Connector B")]));
  const connector = await addedTimes(["Connector A", "Connector B"]);
  check("two calls, two times, in the order added", connector.get("Connector A")! < connector.get("Connector B")!);

  console.log("\nThe app's own Add button\n");
  const before = Date.now();
  const own = await asTestUser(() => tasks.createTask({ title: "Added by hand" }));
  const ownTime = Date.parse(own.createdAt);
  check("uses the time it was added", ownTime >= before - 5000 && ownTime <= Date.now() + 5000, own.createdAt);

  console.log("\nBrought back: keeps its original added time\n");
  // Each test: a task added long ago is deleted, then brought back one way.
  async function oldTask(title: string): Promise<string> {
    const task = await asTestUser(() => tasks.createTask({ title }));
    await owner.query(`UPDATE "Task" SET "createdAt" = $1 WHERE id = $2`, [OLD, task.id]);
    return task.id;
  }
  const keptOld = async (title: string) => (await addedTimes([title])).get(title) === OLD;

  const viaBin = await oldTask("Restored from Recently deleted");
  await asTestUser(() => tasks.deleteTaskWithCopy(viaBin));
  await asTestUser(() => tasks.restoreFromBin(viaBin));
  check("Restore (Settings → Recently deleted)", await keptOld("Restored from Recently deleted"));

  const viaUndo = await oldTask("Back with Undo");
  const copy = await asTestUser(() => tasks.deleteTaskWithCopy(viaUndo));
  await asTestUser(() => tasks.restoreDeletedTask(copy));
  check("Undo after a delete", await keptOld("Back with Undo"));

  const viaBatch = await oldTask("Back with batch Undo");
  const batch = await asTestUser(() => tasks.deleteManyWithCopies([{ taskId: viaBatch }]));
  await asTestUser(() => tasks.restoreBatch({ taskIds: batch.taskIds, ticks: batch.ticks }));
  check("Undo after a batch delete", await keptOld("Back with batch Undo"));

  const viaAll = await oldTask("Back with Restore all");
  await asTestUser(() => tasks.deleteTaskWithCopy(viaAll));
  await asTestUser(() => tasks.restoreAllFromBin());
  check("Restore all", await keptOld("Back with Restore all"));
} finally {
  await cleanUp();
  await owner.end();
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
