-- Phase 6.5: make the database itself enforce "each user only sees their own rows".
--
-- Until now the app connected as the table owner (postgres), which skips row level
-- security, so privacy depended only on every query in src/lib/tasks.ts filtering
-- by userId. This migration adds a limited role, app_user, plus rules (policies)
-- that only let it touch rows belonging to the user named in the setting
-- app.user_id. The app switches to app_user for each request in Phase 6.5 step 2.
--
-- Applying this changes nothing for the running app on its own: the owner role
-- still skips the rules until the app code starts using app_user.
--
-- The public Data API stays locked: its roles (anon, authenticated) are not given
-- anything here, and they can't switch to app_user.

-- 1. The role. NOLOGIN: nobody can connect as it directly; the app's normal
--    connection switches into it. Roles are shared by the whole database server,
--    so only create it if it isn't there yet (Prisma's temporary test database
--    replays this file on the same server).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOINHERIT;
  END IF;
END
$$;

-- Let the app's connection (postgres) switch into app_user.
GRANT app_user TO postgres;

-- 2. What app_user may do: read and change rows in the four app tables (the
--    policies below then decide WHICH rows). Nothing else — it can't create or
--    drop tables, and it can't see Prisma's _prisma_migrations table.
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Category", "Task", "Subtask", "TaskCompletion" TO app_user;

-- 3. The rules. Each one compares a row's owner with app.user_id, which the app
--    sets per request to the signed-in user's id (from their verified login).
--    If it isn't set, the comparison is with nothing, so no rows match.
--    - USING decides which existing rows can be seen, changed or deleted.
--    - WITH CHECK decides which rows can be saved, so nobody can create a row
--      for another user or move one to another user.
--    The (select ...) wrapper makes Postgres look the setting up once per query
--    instead of once per row.

CREATE POLICY "own categories" ON "Category"
  FOR ALL TO app_user
  USING ("userId" = (select nullif(current_setting('app.user_id', true), '')::uuid))
  WITH CHECK ("userId" = (select nullif(current_setting('app.user_id', true), '')::uuid));

CREATE POLICY "own tasks" ON "Task"
  FOR ALL TO app_user
  USING ("userId" = (select nullif(current_setting('app.user_id', true), '')::uuid))
  WITH CHECK ("userId" = (select nullif(current_setting('app.user_id', true), '')::uuid));

-- Steps and completions have no userId of their own: they belong to whoever owns
-- their task. (The lookup into "Task" is itself limited by the rule above.)
CREATE POLICY "steps of own tasks" ON "Subtask"
  FOR ALL TO app_user
  USING (EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = "Subtask"."taskId"
                 AND t."userId" = (select nullif(current_setting('app.user_id', true), '')::uuid)))
  WITH CHECK (EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = "Subtask"."taskId"
                      AND t."userId" = (select nullif(current_setting('app.user_id', true), '')::uuid)));

CREATE POLICY "completions of own tasks" ON "TaskCompletion"
  FOR ALL TO app_user
  USING (EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = "TaskCompletion"."taskId"
                 AND t."userId" = (select nullif(current_setting('app.user_id', true), '')::uuid)))
  WITH CHECK (EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = "TaskCompletion"."taskId"
                      AND t."userId" = (select nullif(current_setting('app.user_id', true), '')::uuid)));

-- Reminder for future tables (e.g. push subscriptions): new tables start locked
-- (see lock_public_api), so each one needs its own GRANT to app_user and its own
-- policy here before the app can use it.
