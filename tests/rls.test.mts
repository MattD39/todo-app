// Proof that the database itself keeps each user's data private (Phase 6.5).
//
// Run with: npm run test:rls
//
// Each test acts the way the app does (switches to the app_user role and sets
// app.user_id, like runAsUser in src/lib/db.ts) and then runs queries with NO
// userId filter on purpose — the mistake row level security exists to catch.
//
// Safe to run against the real database: every test runs inside a transaction
// that is always rolled back, so nothing it creates or changes is ever kept.
// It prints no ids, emails or task titles.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const OTHER_USER = "00000000-0000-4000-8000-000000000001"; // a made-up second user
const NOBODY = "00000000-0000-4000-8000-000000000000"; // a made-up user with no rows

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
let you: string | null = null; // the real user who owns the tasks in the database

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is missing — run this with: npm run test:rls");
  await client.connect();
  // As the owner (which skips the rules), find whose tasks are in the database.
  const { rows } = await client.query(`SELECT "userId" FROM "Task" ORDER BY "createdAt" DESC LIMIT 1`);
  you = rows[0]?.userId ?? null;
});

after(async () => {
  await client.end();
});

// Runs `work` in a transaction that is always rolled back.
async function inThrowawayTransaction(work: () => Promise<void>) {
  await client.query("BEGIN");
  try {
    await work();
  } finally {
    await client.query("ROLLBACK");
  }
}

// Act as the app does for a signed-in user (null = the app forgot to say who).
async function actAs(userId: string | null) {
  await client.query(`SELECT set_config('role', 'app_user', true), set_config('app.user_id', $1, true)`, [
    userId ?? "",
  ]);
}

// Go back to the owner role (skips the rules), to set up or inspect data.
async function actAsOwner() {
  await client.query(`SELECT set_config('role', 'none', true)`); // "none" = back to the account we connected as
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM (${sql}) AS q`, params);
  return rows[0].n;
}

async function countAll() {
  return {
    tasks: await count(`SELECT 1 FROM "Task"`),
    steps: await count(`SELECT 1 FROM "Subtask"`),
    completions: await count(`SELECT 1 FROM "TaskCompletion"`),
    categories: await count(`SELECT 1 FROM "Category"`),
  };
}

// The database must refuse this statement. A savepoint keeps the refusal from
// spoiling the rest of the transaction.
async function assertRefused(sql: string, params: unknown[] = []) {
  await client.query("SAVEPOINT attempt");
  try {
    await client.query(sql, params);
    assert.fail(`The database allowed it: ${sql}`);
  } catch (error) {
    assert.match((error as Error).message, /row-level security/);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT attempt");
  }
}

// Creates a task (with a step, a category and a completion) owned by OTHER_USER.
async function createOtherUsersTask(): Promise<string> {
  await actAsOwner();
  const category = await client.query(
    `INSERT INTO "Category" (id, "userId", name) VALUES (gen_random_uuid(), $1, 'Other user''s category') RETURNING id`,
    [OTHER_USER],
  );
  const task = await client.query(
    `INSERT INTO "Task" (id, "userId", title, "categoryId", "updatedAt")
     VALUES (gen_random_uuid(), $1, 'Other user''s private task', $2, now()) RETURNING id`,
    [OTHER_USER, category.rows[0].id],
  );
  const taskId: string = task.rows[0].id;
  await client.query(`INSERT INTO "Subtask" (id, "taskId", title) VALUES (gen_random_uuid(), $1, 'Their step')`, [
    taskId,
  ]);
  await client.query(
    `INSERT INTO "TaskCompletion" (id, "taskId", "completedOn") VALUES (gen_random_uuid(), $1, current_date)`,
    [taskId],
  );
  return taskId;
}

test("a user with no rows sees nothing, even with no userId filter", async () => {
  await inThrowawayTransaction(async () => {
    await actAs(NOBODY);
    assert.deepEqual(await countAll(), { tasks: 0, steps: 0, completions: 0, categories: 0 });
  });
});

test("if the app forgets to say who is signed in, nothing is visible", async () => {
  await inThrowawayTransaction(async () => {
    await actAs(null);
    assert.deepEqual(await countAll(), { tasks: 0, steps: 0, completions: 0, categories: 0 });
  });
});

test("you see exactly your own tasks with no userId filter", async (t) => {
  if (!you) return t.skip("no tasks in the database to compare with");
  await inThrowawayTransaction(async () => {
    const yours = await count(`SELECT 1 FROM "Task" WHERE "userId" = $1`, [you]); // as owner, filtered
    await actAs(you);
    assert.equal(await count(`SELECT 1 FROM "Task"`), yours); // as you, unfiltered
  });
});

test("another user's task, step, completion and category stay invisible to you", async (t) => {
  if (!you) return t.skip("no tasks in the database to compare with");
  await inThrowawayTransaction(async () => {
    const theirTask = await createOtherUsersTask();
    const yoursBefore = await count(`SELECT 1 FROM "Task" WHERE "userId" = $1`, [you]);

    await actAs(you);
    assert.equal(await count(`SELECT 1 FROM "Task" WHERE id = $1`, [theirTask]), 0, "their task");
    assert.equal(await count(`SELECT 1 FROM "Subtask" WHERE "taskId" = $1`, [theirTask]), 0, "their step");
    assert.equal(await count(`SELECT 1 FROM "TaskCompletion" WHERE "taskId" = $1`, [theirTask]), 0, "their tick");
    assert.equal(await count(`SELECT 1 FROM "Category" WHERE "userId" = $1`, [OTHER_USER]), 0, "their category");
    assert.equal(await count(`SELECT 1 FROM "Task"`), yoursBefore, "unfiltered list is only yours");

    // And the other way round: they see only their own task, not yours.
    await actAs(OTHER_USER);
    assert.equal(await count(`SELECT 1 FROM "Task"`), 1);
    assert.equal(await count(`SELECT 1 FROM "Task" WHERE "userId" = $1`, [you]), 0);
  });
});

test("you can't change or delete another user's rows", async (t) => {
  if (!you) return t.skip("no tasks in the database to compare with");
  await inThrowawayTransaction(async () => {
    const theirTask = await createOtherUsersTask();

    await actAs(you);
    const changed = await client.query(`UPDATE "Task" SET title = 'changed' WHERE id = $1`, [theirTask]);
    const deleted = await client.query(`DELETE FROM "Task" WHERE id = $1`, [theirTask]);
    const stepChanged = await client.query(`UPDATE "Subtask" SET done = true WHERE "taskId" = $1`, [theirTask]);
    assert.equal(changed.rowCount, 0, "update");
    assert.equal(deleted.rowCount, 0, "delete");
    assert.equal(stepChanged.rowCount, 0, "step update");

    await actAsOwner();
    const { rows } = await client.query(`SELECT title FROM "Task" WHERE id = $1`, [theirTask]);
    assert.equal(rows[0]?.title, "Other user's private task", "their task is untouched");
  });
});

test("you can't create rows for another user or hand yours over", async (t) => {
  if (!you) return t.skip("no tasks in the database to compare with");
  await inThrowawayTransaction(async () => {
    const theirTask = await createOtherUsersTask();

    await actAs(you);
    await assertRefused(
      `INSERT INTO "Task" (id, "userId", title, "updatedAt") VALUES (gen_random_uuid(), $1, 'sneaky', now())`,
      [OTHER_USER],
    );
    await assertRefused(`INSERT INTO "Subtask" (id, "taskId", title) VALUES (gen_random_uuid(), $1, 'sneaky')`, [
      theirTask,
    ]);
    await assertRefused(
      `INSERT INTO "TaskCompletion" (id, "taskId", "completedOn") VALUES (gen_random_uuid(), $1, current_date)`,
      [theirTask],
    );
    await assertRefused(`INSERT INTO "Category" (id, "userId", name) VALUES (gen_random_uuid(), $1, 'sneaky')`, [
      OTHER_USER,
    ]);
    await assertRefused(`UPDATE "Task" SET "userId" = $1 WHERE "userId" = $2`, [OTHER_USER, you]);
  });
});

test("the switch to app_user ends with the transaction", async () => {
  await inThrowawayTransaction(async () => {
    await actAs(NOBODY);
  });
  const { rows } = await client.query(`SELECT current_user AS role, current_setting('app.user_id', true) AS uid`);
  assert.notEqual(rows[0].role, "app_user");
  assert.ok(!rows[0].uid, "no user id left behind");
});

test("the public web API (Supabase Data API) is still locked", async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  assert.ok(url && key, "Supabase URL or publishable key is missing from .env.local");
  for (const table of ["Task", "Subtask", "TaskCompletion", "Category"]) {
    const response: Response = await fetch(`${url}/rest/v1/${table}?select=*`, { headers: { apikey: key } });
    assert.equal(response.status, 401, table);
  }
});
