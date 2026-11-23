-- Photo to schedule (5a): a limit on chat messages with a photo attached
-- (3 a minute, 10 a day per person; see src/lib/usage.ts). Each photo message
-- is one row in "ClaudeUsage" with this new feature name. Purely additive: an
-- extra allowed value; no existing rows, rules or permissions change.
ALTER TYPE "ClaudeFeature" ADD VALUE IF NOT EXISTS 'chat_photo';
