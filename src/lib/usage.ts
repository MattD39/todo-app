import "server-only";
import { getCurrentUser } from "./auth";
import { ClaudeMeter } from "./claude";
import { runAsUser } from "./db";
import { getTimeZone } from "./timezone";
import type { ClaudeFeature } from "@/generated/prisma/enums";

// ─────────────────────────────────────────────────────────────────────────────
// Limits on how much each person can use Claude, checked on the server before
// every Claude request, so they work however the request was sent.
//
// Every use is a row in the ClaudeUsage table (only this file reads or writes
// it). Before calling Claude, startClaudeUse() counts the person's rows:
//   - per minute, per feature: stops a stuck button or a loop;
//   - per day, per feature: a fair share each;
//   - money spent today, all features together: the real safety net, since
//     one long chat can cost much more than a short one.
// "Today" starts at midnight in the person's own time zone.
// ─────────────────────────────────────────────────────────────────────────────

export type { ClaudeFeature };

type Limit = { perMinute: number; perDay: number; name: string };

export const LIMITS: Record<ClaudeFeature, Limit> = {
  suggest_steps: { perMinute: 5, perDay: 30, name: "step suggestions" },
  ask: { perMinute: 5, perDay: 30, name: "Ask Claude questions" },
  chat: { perMinute: 6, perDay: 40, name: "chat messages" },
};

// Most one person can spend on Claude in a day, in US dollars, all features
// together. $0.15 a day is about $4.50 a month.
export const DAILY_SPEND_CAP_USD = 0.15;

// A limit was reached. The message is safe to show as it is.
export class LimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number, // how long until it's allowed again
  ) {
    super(message);
  }
}

// One use of a Claude feature that has been allowed and counted.
export type ClaudeUse = {
  // Uses of this feature left today, after this one.
  leftToday: number;
  // Pass this to the code that calls Claude: it adds up the cost.
  meter: ClaudeMeter;
  // Saves what it cost. Call it once Claude has finished (or failed, or been
  // stopped). Never throws: a problem saving is logged, not shown.
  finish: () => Promise<void>;
};

// Checks the limits for `feature` and, if they allow it, counts this use.
// Throws LimitError if a limit has been reached (nothing is counted then).
// Sends signed-out visitors to /login, like everything else.
export async function startClaudeUse(feature: ClaudeFeature): Promise<ClaudeUse> {
  const user = await getCurrentUser();
  return startClaudeUseFor(user.id, await getTimeZone(), feature);
}

// The work behind startClaudeUse, for a user who has already been checked.
// Only for startClaudeUse and the checks in scripts/check-limits.mts (which
// can't sign in): userId must come from a verified login, never from input.
export async function startClaudeUseFor(userId: string, timeZone: string, feature: ClaudeFeature): Promise<ClaudeUse> {
  const user = { id: userId };
  const limit = LIMITS[feature];

  const started = await runAsUser(user.id, async (tx) => {
    // One check at a time per person: two requests sent at the same moment
    // can't both squeeze through the last free place. (Released when this
    // transaction ends.)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('claude-usage:' || ${user.id}))`;

    // All the times come from the database clock. Midnight is worked out in
    // the person's time zone (Postgres knows the same names as the browser).
    // A use counts towards the daily limit unless Claude failed before doing
    // anything (finished with nothing read or written), e.g. Claude was busy.
    const [counts] = await tx.$queryRaw<UsageCounts[]>`
      WITH day AS (
        SELECT (date_trunc('day', now() AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone}) AS starts,
               ((date_trunc('day', now() AT TIME ZONE ${timeZone}) + interval '1 day') AT TIME ZONE ${timeZone}) AS ends
      )
      SELECT
        count(*) FILTER (WHERE u."feature" = ${feature}::"ClaudeFeature"
                           AND u."startedAt" > now() - interval '1 minute')::int AS "lastMinute",
        ceil(extract(epoch FROM min(u."startedAt") FILTER (WHERE u."feature" = ${feature}::"ClaudeFeature"
                           AND u."startedAt" > now() - interval '1 minute') + interval '1 minute' - now()))::int
          AS "minuteFreesIn",
        count(*) FILTER (WHERE u."feature" = ${feature}::"ClaudeFeature"
                           AND u."startedAt" >= day.starts
                           AND NOT (u."finishedAt" IS NOT NULL AND u."inputTokens" = 0 AND u."outputTokens" = 0))::int
          AS "today",
        coalesce(sum(u."costUsd") FILTER (WHERE u."startedAt" >= day.starts), 0)::float8 AS "spentToday",
        ceil(extract(epoch FROM day.ends - now()))::int AS "dayEndsIn"
      FROM day
      LEFT JOIN "ClaudeUsage" u
        ON u."userId" = ${user.id}::uuid
       AND u."startedAt" >= least(day.starts, now() - interval '1 minute')
      GROUP BY day.starts, day.ends`;

    checkLimits(limit, counts);

    // Written by hand: the database only lets the app fill in these three
    // columns (Prisma's create would send the others too). startedAt comes
    // from the database clock.
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "ClaudeUsage" ("id", "userId", "feature")
      VALUES (gen_random_uuid(), ${user.id}::uuid, ${feature}::"ClaudeFeature")
      RETURNING "id"`;
    return { rowId: row.id, leftToday: limit.perDay - counts.today - 1 };
  });

  const meter = new ClaudeMeter();
  let finished = false;
  return {
    leftToday: started.leftToday,
    meter,
    finish: async () => {
      if (finished) return;
      finished = true;
      try {
        // No login check here on purpose: this often runs after the reply has
        // been sent (streaming), when the request's cookies are gone. The user
        // id was checked above, and the database rules still apply.
        await runAsUser(
          user.id,
          (tx) => tx.$executeRaw`
            UPDATE "ClaudeUsage"
            SET "finishedAt" = now(), "inputTokens" = ${meter.inputTokens},
                "outputTokens" = ${meter.outputTokens}, "costUsd" = ${meter.costUsd}
            WHERE "id" = ${started.rowId}::uuid AND "userId" = ${user.id}::uuid`,
        );
      } catch (error) {
        console.error("Couldn't save what a Claude request cost", error);
      }
    },
  };
}

type UsageCounts = {
  lastMinute: number;
  minuteFreesIn: number | null;
  today: number;
  spentToday: number;
  dayEndsIn: number;
};

// Throws LimitError if any limit has been reached. Exported for the checks in
// scripts/check-limits.mts.
export function checkLimits(limit: Limit, counts: UsageCounts): void {
  if (counts.lastMinute >= limit.perMinute) {
    const seconds = Math.max(1, counts.minuteFreesIn ?? 60);
    throw new LimitError(
      `That's a lot of requests at once. Wait about ${seconds} second${seconds === 1 ? "" : "s"} and try again.`,
      seconds,
    );
  }
  if (counts.today >= limit.perDay) {
    throw new LimitError(`You've used today's ${limit.perDay} ${limit.name}. More at midnight.`, counts.dayEndsIn);
  }
  if (counts.spentToday >= DAILY_SPEND_CAP_USD) {
    throw new LimitError("You've reached today's Claude limit. It resets at midnight.", counts.dayEndsIn);
  }
}
