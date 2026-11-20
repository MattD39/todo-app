-- Phase 8 Step 8e: a limit on changes Claude makes through the MCP server
-- (20 a minute, 200 a day per person; see src/lib/usage.ts). Each change is
-- one row in "ClaudeUsage" with this new feature name. Purely additive: an
-- extra allowed value; no existing rows, rules or permissions change.
ALTER TYPE "ClaudeFeature" ADD VALUE IF NOT EXISTS 'mcp_change';
