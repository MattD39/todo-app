-- CreateTable
CREATE TABLE "RecentlyDeleted" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "copy" JSONB NOT NULL,
    "deletedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecentlyDeleted_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecentlyDeleted_userId_deletedAt_idx" ON "RecentlyDeleted"("userId", "deletedAt");

-- ─── Locking it down ─────────────────────────────────────────────────────────
-- Same protection as the other tables (see row_level_security): the public
-- Data API can't see it (new tables start with no grants for anon/authenticated,
-- see lock_public_api), and the app's limited role app_user only reaches the
-- signed-in user's own rows.
ALTER TABLE "RecentlyDeleted" ENABLE ROW LEVEL SECURITY;

-- What app_user may do:
--   - read your bin (the list in Settings);
--   - put a task in it, but only its id, owner and copy: the time it was
--     deleted always comes from the database clock, so nothing can make an
--     item look newer and stay past its 30 days;
--   - take one out (Restore, Delete forever, Empty bin, the 30-day clear-out);
--   - no UPDATE: a binned copy is never edited, only put back or removed.
GRANT SELECT, DELETE ON "RecentlyDeleted" TO app_user;
GRANT INSERT ("id", "userId", "copy") ON "RecentlyDeleted" TO app_user;

-- Which rows: only the user named in app.user_id (set per request by runAsUser).
CREATE POLICY "own recently deleted" ON "RecentlyDeleted"
  FOR ALL TO app_user
  USING ("userId" = (select nullif(current_setting('app.user_id', true), '')::uuid))
  WITH CHECK ("userId" = (select nullif(current_setting('app.user_id', true), '')::uuid));

-- The copy is always one task (a JSON object), never a list or a bare value.
ALTER TABLE "RecentlyDeleted" ADD CONSTRAINT "RecentlyDeleted_copy_is_object"
  CHECK (jsonb_typeof("copy") = 'object');
