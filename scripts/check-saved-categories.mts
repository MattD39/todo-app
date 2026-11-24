//
// Checks saved categories ("like contacts", step g1): the database change and
// the server functions behind Settings → Categories and the task sheet.
//
// Run with: npm run check:saved-categories
//
// Free: no Claude calls. Runs the real server code (src/lib/tasks.ts) for a
// MADE-UP test user (not you), with the database's privacy rules on:
//   - the new "saved" column and the new-account trigger are in place, and a
//     brand-new account gets Work, Fitness, Errands and Personal (tested with
//     a fake account inside a transaction that's always undone);
//   - add / save a one-off / rename / delete, with their safety rules;
//   - the saved list and the one-offs in use, with task counts;
//   - typing a saved name in any capitals uses the saved one;
//   - another person's categories are never seen or changed;
//   - the chip rule (g3): saved = while any task has it, one-off = only while
//     an unfinished task has it; the task sheet lists only saved ones.
// Only the made-up people's rows are created and deleted; your own data is
// never touched or shown. Exits with an error if any check fails.

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

const TEST_USER = "00000000-0000-4000-8000-0000000c0001"; // nobody real
const OTHER_USER = "00000000-0000-4000-8000-0000000c0002"; // a second made-up person
const NEW_ACCOUNT = "00000000-0000-4000-8000-0000000c0003"; // a fake sign-up, always rolled back
const asTestUser = <T,>(work: () => Promise<T>) =>
  auth.runAsVerifiedUser({ id: TEST_USER, email: null, timeZone: "America/Halifax" }, work);

const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
await owner.connect();

async function cleanUp() {
  for (const user of [TEST_USER, OTHER_USER]) {
    await owner.query(`DELETE FROM "Task" WHERE "userId" = $1`, [user]);
    await owner.query(`DELETE FROM "Category" WHERE "userId" = $1`, [user]);
  }
}
async function addCategory(user: string, name: string, saved: boolean): Promise<string> {
  const { rows } = await owner.query(
    `INSERT INTO "Category" (id, "userId", name, saved) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
    [user, name, saved],
  );
  return rows[0].id;
}
async function addTask(user: string, title: string, categoryId: string | null, done = false) {
  await owner.query(
    `INSERT INTO "Task" (id, "userId", title, "categoryId", done, "doneAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, CASE WHEN $4 THEN now() END, now())`,
    [user, title, categoryId, done],
  );
}
const categoryOf = async (user: string, name: string) =>
  (await owner.query(`SELECT id, name, saved FROM "Category" WHERE "userId" = $1 AND lower(name) = lower($2)`, [user, name]))
    .rows;
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

  // ── The database change ──
  console.log("\nThe database change\n");
  const { rows: column } = await owner.query(
    `SELECT data_type, column_default, is_nullable FROM information_schema.columns
     WHERE table_name = 'Category' AND column_name = 'saved'`,
  );
  check(
    'Category has a "saved" column (true/false, default false, never empty)',
    column[0]?.data_type === "boolean" && column[0]?.column_default === "false" && column[0]?.is_nullable === "NO",
    JSON.stringify(column[0]),
  );

  // A brand-new account (fake, inside a transaction that's always undone).
  await owner.query("BEGIN");
  let starters: { name: string; saved: boolean }[] = [];
  try {
    await owner.query(`INSERT INTO auth.users (id) VALUES ($1)`, [NEW_ACCOUNT]);
    starters = (await owner.query(`SELECT name, saved FROM "Category" WHERE "userId" = $1 ORDER BY name`, [NEW_ACCOUNT]))
      .rows;
  } finally {
    await owner.query("ROLLBACK");
  }
  check(
    "a new account starts with Work, Fitness, Errands and Personal, all saved",
    JSON.stringify(starters) ===
      JSON.stringify(["Errands", "Fitness", "Personal", "Work"].map((name) => ({ name, saved: true }))),
    JSON.stringify(starters),
  );
  const { rows: leftover } = await owner.query(`SELECT 1 FROM auth.users WHERE id = $1`, [NEW_ACCOUNT]);
  check("…and the fake account was undone (nothing left behind)", leftover.length === 0);
  const { rows: grants } = await owner.query(
    `SELECT has_function_privilege('anon', 'public.add_starter_categories()', 'EXECUTE') AS anon,
            has_function_privilege('authenticated', 'public.add_starter_categories()', 'EXECUTE') AS authed,
            has_function_privilege('app_user', 'public.add_starter_categories()', 'EXECUTE') AS app`,
  );
  check(
    "the starter function can't be run from the web API or the app (only by the trigger)",
    grants[0].anon === false && grants[0].authed === false && grants[0].app === false,
    JSON.stringify(grants[0]),
  );

  // ── The saved list ──
  console.log("\nThe saved list\n");
  const work = await addCategory(TEST_USER, "Work", true);
  await addCategory(TEST_USER, "Fitness", true);
  const party = await addCategory(TEST_USER, "Birthday party", false);
  await addTask(TEST_USER, "Report", work);
  await addTask(TEST_USER, "Old report", work, true);
  await addTask(TEST_USER, "Buy balloons", party);
  const theirs = await addCategory(OTHER_USER, "Their category", true);

  const saved = await asTestUser(() => tasks.listSavedCategories());
  check(
    "the saved list: A to Z, with task counts (finished ones counted too)",
    JSON.stringify(saved.map((c) => [c.name, c.tasks, c.finished])) === JSON.stringify([["Fitness", 0, 0], ["Work", 2, 1]]),
    JSON.stringify(saved),
  );
  const oneOffs = await asTestUser(() => tasks.listOneOffCategories());
  check(
    "one-offs in use: Birthday party (1 unfinished task)",
    JSON.stringify(oneOffs.map((c) => [c.name, c.tasks])) === JSON.stringify([["Birthday party", 1]]),
    JSON.stringify(oneOffs),
  );
  check("someone else's categories never show", !saved.some((c) => c.name === "Their category"));

  // ── Adding and saving ──
  console.log("\nAdding and saving\n");
  let s = await asTestUser(() => tasks.saveCategory("  Garden   jobs "));
  check(
    "add a new one: saved, with tidy spaces",
    s.name === "Garden jobs" && !s.alreadySaved && (await categoryOf(TEST_USER, "Garden jobs"))[0]?.saved === true,
    JSON.stringify(s),
  );
  s = await asTestUser(() => tasks.saveCategory("work"));
  check("add one that's already saved (any capitals): nothing changes, says so", s.alreadySaved && s.name === "Work");
  s = await asTestUser(() => tasks.saveCategory("birthday PARTY"));
  const partyRows = await categoryOf(TEST_USER, "Birthday party");
  check(
    "save a one-off (any capitals): the same category becomes saved, keeping its name and tasks",
    !s.alreadySaved && s.name === "Birthday party" && partyRows.length === 1 && partyRows[0].id === party && partyRows[0].saved,
    JSON.stringify({ s, partyRows }),
  );
  check("an empty name is refused", (await errorOf(() => asTestUser(() => tasks.saveCategory("   ")))) !== null);
  check(
    "a name over 40 characters is refused",
    (await errorOf(() => asTestUser(() => tasks.saveCategory("x".repeat(41)))))?.includes("40") === true,
  );

  // ── Renaming ──
  console.log("\nRenaming\n");
  const renamed = await asTestUser(() => tasks.renameCategory(work, "Job"));
  check("rename Work to Job: its tasks follow", renamed === "Job" && (await categoryOf(TEST_USER, "Job"))[0]?.id === work);
  check(
    "rename to a name another category has (any capitals) is refused",
    (await errorOf(() => asTestUser(() => tasks.renameCategory(work, "FITNESS"))))?.includes("already have") === true,
  );
  check(
    "changing only the capitals is fine",
    (await asTestUser(() => tasks.renameCategory(work, "JOB"))) === "JOB",
  );
  check(
    "someone else's category can't be renamed",
    (await errorOf(() => asTestUser(() => tasks.renameCategory(theirs, "Mine now")))) !== null &&
      (await categoryOf(OTHER_USER, "Their category")).length === 1,
  );

  // ── Deleting ──
  console.log("\nDeleting\n");
  const usage = await asTestUser(() => tasks.categoryUsage(work));
  check(
    "before deleting: counts for the confirm box (2 tasks, 1 finished)",
    usage.name === "JOB" && usage.tasks === 2 && usage.finished === 1,
    JSON.stringify(usage),
  );
  const lost = await asTestUser(() => tasks.deleteSavedCategory(work));
  const { rows: orphans } = await owner.query(
    `SELECT title, "categoryId" FROM "Task" WHERE "userId" = $1 AND title IN ('Report', 'Old report') ORDER BY title`,
    [TEST_USER],
  );
  check(
    "delete it: both tasks stay, with no category, and the category is gone",
    lost === 2 && orphans.length === 2 && orphans.every((t) => t.categoryId === null) && (await categoryOf(TEST_USER, "JOB")).length === 0,
    JSON.stringify({ lost, orphans }),
  );
  check(
    "someone else's category can't be deleted (or counted)",
    (await errorOf(() => asTestUser(() => tasks.deleteSavedCategory(theirs)))) !== null &&
      (await errorOf(() => asTestUser(() => tasks.categoryUsage(theirs)))) !== null &&
      (await categoryOf(OTHER_USER, "Their category")).length === 1,
  );
  // ── Chips and the task sheet's list (g3) ──
  console.log("\nChips and the task sheet's list\n");
  await cleanUp();
  const savedDone = await addCategory(TEST_USER, "Saved finished only", true);
  await addTask(TEST_USER, "Done thing", savedDone, true);
  await addCategory(TEST_USER, "Saved unused", true);
  const oneOffOpen = await addCategory(TEST_USER, "One-off open", false);
  await addTask(TEST_USER, "Open thing", oneOffOpen);
  const oneOffDone = await addCategory(TEST_USER, "One-off finished only", false);
  await addTask(TEST_USER, "Finished thing", oneOffDone, true);
  const chips = (await asTestUser(() => tasks.listCategories())).map((c) => c.name);
  check(
    "chips: a saved category with only finished tasks keeps its chip; a one-off with an unfinished task has one",
    JSON.stringify(chips) === JSON.stringify(["One-off open", "Saved finished only"]),
    JSON.stringify(chips),
  );
  check("…a one-off whose tasks are all finished has no chip", !chips.includes("One-off finished only"));
  check("…a saved category no task uses has no chip", !chips.includes("Saved unused"));
  const names = await asTestUser(() => tasks.listSavedCategoryNames());
  check(
    "the task sheet's list: only saved categories, A to Z (used or not)",
    JSON.stringify(names) === JSON.stringify(["Saved finished only", "Saved unused"]),
    JSON.stringify(names),
  );
  await owner.query(`UPDATE "Task" SET done = true WHERE title = 'Open thing' AND "userId" = $1`, [TEST_USER]);
  check(
    "finishing a one-off's last unfinished task removes its chip",
    !(await asTestUser(() => tasks.listCategories())).some((c) => c.name === "One-off open"),
  );

  check(
    "a signed-out visitor can't add, rename or delete",
    (await errorOf(() => tasks.saveCategory("Sneaky"))) !== null &&
      (await errorOf(() => tasks.renameCategory(party, "Sneaky"))) !== null &&
      (await errorOf(() => tasks.deleteSavedCategory(party))) !== null,
  );
} finally {
  await cleanUp();
  await owner.end();
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
