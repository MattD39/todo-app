-- CreateEnum
CREATE TYPE "ClaudeFeature" AS ENUM ('suggest_steps', 'ask', 'chat');

-- CreateTable
CREATE TABLE "ClaudeUsage" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "feature" "ClaudeFeature" NOT NULL,
    "startedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "ClaudeUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaudeUsage_userId_startedAt_idx" ON "ClaudeUsage"("userId", "startedAt");

-- ─── Locking it down (Phase 7 Step 5) ────────────────────────────────────────
-- Same protection as the other tables (see row_level_security): the public
-- Data API can't see it (new tables start with no grants for anon/authenticated,
-- see lock_public_api), and the app's limited role app_user only reaches the
-- signed-in user's own rows.
ALTER TABLE "ClaudeUsage" ENABLE ROW LEVEL SECURITY;

-- What app_user may do, column by column, so the limits can't be dodged:
--   - add a row, but only the id, owner and feature; the start time always
--     comes from the database clock, never from the app;
--   - fill in the result (finish time, token counts, cost), but never change
--     who, which feature or when;
--   - no DELETE: a used request can't be "un-counted".
GRANT SELECT ON "ClaudeUsage" TO app_user;
GRANT INSERT ("id", "userId", "feature") ON "ClaudeUsage" TO app_user;
GRANT UPDATE ("finishedAt", "inputTokens", "outputTokens", "costUsd") ON "ClaudeUsage" TO app_user;

-- Which rows: only the user named in app.user_id (set per request by runAsUser).
CREATE POLICY "own usage" ON "ClaudeUsage"
  FOR ALL TO app_user
  USING ("userId" = (select nullif(current_setting('app.user_id', true), '')::uuid))
  WITH CHECK ("userId" = (select nullif(current_setting('app.user_id', true), '')::uuid));

-- Counts and costs can't go below zero.
ALTER TABLE "ClaudeUsage" ADD CONSTRAINT "ClaudeUsage_amounts_not_negative"
  CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0 AND "costUsd" >= 0);
