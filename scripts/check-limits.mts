//
// Checks the Claude limits really work (src/lib/usage.ts).
//
// Run with: npm run check:limits
//
// Free: no Claude calls. Part 1 checks the limit rules and cost sums on their
// own. Part 2 uses the real database with a MADE-UP test user (not you), so
// your own counts are never touched; that user's rows are deleted at the
// start and the end. Prints no personal data. Exits with an error if any
// check fails.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import pg from "pg";

// Load the app's server code (which normally only runs inside Next.js).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "server-only": path.join(root, "scripts/server-only-stub.cjs"),
    "@/": path.join(root, "src") + path.sep,
  },
});
const usage = await jiti.import<typeof import("../src/lib/usage.ts")>(path.join(root, "src/lib/usage.ts"));
const { ClaudeMeter, MAX_TOKENS } = await jiti.import<typeof import("../src/lib/claude.ts")>(
  path.join(root, "src/lib/claude.ts"),
);
const { LIMITS, DAILY_SPEND_CAP_USD, LimitError, checkLimits, startClaudeUseFor } = usage;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
}

// What a function threw (or null if it didn't).
async function thrown(work: () => unknown): Promise<unknown> {
  try {
    await work();
    return null;
  } catch (error) {
    return error;
  }
}
const describe = (e: unknown) => (e === null ? "allowed" : e instanceof Error ? e.message : String(e));

// ─── Part 1: the rules, without the database ─────────────────────────────────
console.log("Part 1: the limit rules and cost sums (no database)\n");

const suggest = LIMITS.suggest_steps;
const quiet = { lastMinute: 0, minuteFreesIn: null, today: 0, spentToday: 0, dayEndsIn: 3600 };

check("under every limit: allowed", (await thrown(() => checkLimits(suggest, quiet))) === null);

const perMinute = await thrown(() => checkLimits(suggest, { ...quiet, lastMinute: suggest.perMinute, minuteFreesIn: 17 }));
check(
  "too many in a minute: refused, with the real wait",
  perMinute instanceof LimitError && perMinute.retryAfterSeconds === 17 && /Wait about 17 seconds/.test(perMinute.message),
  describe(perMinute),
);

const perDay = await thrown(() => checkLimits(suggest, { ...quiet, today: suggest.perDay }));
check(
  "daily limit reached: refused until midnight",
  perDay instanceof LimitError && perDay.retryAfterSeconds === 3600 && /today's 30 step suggestions\. More at midnight/.test(perDay.message),
  describe(perDay),
);

const spend = await thrown(() => checkLimits(suggest, { ...quiet, spentToday: DAILY_SPEND_CAP_USD }));
check(
  "daily spending cap reached: refused",
  spend instanceof LimitError && /today's Claude limit/.test(spend.message),
  describe(spend),
);

const meter = new ClaudeMeter();
meter.add({ input_tokens: 1000, output_tokens: 500 } as never);
const expectedCost = (1000 * 0.1 + 500 * 0.5) / 1_000_000;
check(
  "a finished reply costs what Claude reports",
  meter.inputTokens === 1000 && meter.outputTokens === 500 && Math.abs(meter.costUsd - expectedCost) < 1e-12,
  `cost ${meter.costUsd}`,
);
const stopped = new ClaudeMeter();
stopped.addUnfinished(200, true);
check(
  "pressing Stop counts as the longest possible reply (on the safe side)",
  stopped.inputTokens === 200 && stopped.outputTokens === MAX_TOKENS,
);
const failed = new ClaudeMeter();
failed.addUnfinished(200, false);
check("if Claude itself failed, only what it read counts", failed.outputTokens === 0 && failed.inputTokens === 200);

// ─── Part 2: the real database, with a made-up user ──────────────────────────
console.log("\nPart 2: the real database (made-up test user, cleaned up afterwards)\n");

const TEST_USER = "00000000-0000-4000-8000-00000000d5d5"; // nobody real
const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
await owner.connect();

// A time zone where it's about noon right now, so rows from "a few minutes
// ago" are always today and rows from 25 hours ago are always yesterday,
// whenever this runs. (Etc/GMT+N means N hours BEHIND UTC.)
const n = new Date().getUTCHours() - 12; // -12 … 11
const timeZone = n === 0 ? "Etc/GMT" : n > 0 ? `Etc/GMT+${n}` : `Etc/GMT${n}`;

async function reset() {
  await owner.query(`DELETE FROM "ClaudeUsage" WHERE "userId" = $1`, [TEST_USER]);
}

// Adds `count` past uses straight into the table (as the owner, for setting up).
async function addPast(
  count: number,
  feature: string,
  ago: string,
  { inputTokens = 10, outputTokens = 10, costUsd = 0 } = {},
) {
  await owner.query(
    `INSERT INTO "ClaudeUsage" ("id", "userId", "feature", "startedAt", "finishedAt", "inputTokens", "outputTokens", "costUsd")
     SELECT gen_random_uuid(), $1, $2::"ClaudeFeature", now() - $3::interval, now() - $3::interval, $4, $5, $6
     FROM generate_series(1, $7)`,
    [TEST_USER, feature, ago, inputTokens, outputTokens, costUsd, count],
  );
}

const tryUse = (feature: "suggest_steps" | "ask" | "chat") => startClaudeUseFor(TEST_USER, timeZone, feature);

try {
  await reset();

  // First use: allowed and counted, with the time from the database clock.
  const first = await tryUse("suggest_steps");
  const { rows } = await owner.query(
    `SELECT abs(extract(epoch FROM now() - "startedAt")) < 30 AS "nowish", "finishedAt" FROM "ClaudeUsage" WHERE "userId" = $1`,
    [TEST_USER],
  );
  check(
    "a first use is allowed and counted (time from the database clock)",
    first.leftToday === suggest.perDay - 1 && rows.length === 1 && rows[0].nowish === true,
    `leftToday ${first.leftToday}, rows ${rows.length}`,
  );

  // Finishing saves what it cost.
  first.meter.add({ input_tokens: 1000, output_tokens: 500 } as never);
  await first.finish();
  const saved = await owner.query(
    `SELECT "inputTokens", "outputTokens", "costUsd", "finishedAt" IS NOT NULL AS done FROM "ClaudeUsage" WHERE "userId" = $1`,
    [TEST_USER],
  );
  const row = saved.rows[0];
  check(
    "when a reply ends, its tokens and cost are saved",
    row.inputTokens === 1000 && row.outputTokens === 500 && Math.abs(row.costUsd - expectedCost) < 1e-12 && row.done,
    JSON.stringify(row),
  );

  // Per minute.
  await reset();
  for (let i = 0; i < suggest.perMinute; i++) await tryUse("suggest_steps");
  const sixth = await thrown(() => tryUse("suggest_steps"));
  check(
    `${suggest.perMinute} step suggestions in a minute are fine, the next is refused with a real wait`,
    sixth instanceof LimitError &&
      sixth.retryAfterSeconds >= 1 &&
      sixth.retryAfterSeconds <= 60 &&
      /Wait about \d+ seconds?/.test(sixth.message),
    describe(sixth),
  );

  await reset();
  await addPast(suggest.perMinute, "suggest_steps", "61 seconds");
  const afterMinute = await thrown(() => tryUse("suggest_steps"));
  check("uses from over a minute ago don't count towards the per-minute limit", afterMinute === null, describe(afterMinute));

  // Per day.
  await reset();
  await addPast(suggest.perDay, "suggest_steps", "2 minutes");
  const dayFull = await thrown(() => tryUse("suggest_steps"));
  check(
    `after ${suggest.perDay} step suggestions today, the next is refused until midnight`,
    dayFull instanceof LimitError && /More at midnight/.test(dayFull.message) && dayFull.retryAfterSeconds > 0,
    describe(dayFull),
  );

  await reset();
  await addPast(suggest.perDay, "suggest_steps", "25 hours");
  check("yesterday's uses don't count", (await thrown(() => tryUse("suggest_steps"))) === null);

  await reset();
  await addPast(suggest.perDay, "suggest_steps", "2 minutes", { inputTokens: 0, outputTokens: 0 });
  check(
    "requests where Claude failed before doing anything don't count",
    (await thrown(() => tryUse("suggest_steps"))) === null,
  );

  await reset();
  await addPast(suggest.perDay, "suggest_steps", "2 minutes");
  const chatStill = await thrown(() => tryUse("chat"));
  check("each feature has its own count (Chat still works)", chatStill === null, describe(chatStill));

  // Spending cap, all features together.
  await reset();
  await addPast(1, "chat", "2 minutes", { costUsd: DAILY_SPEND_CAP_USD });
  const capped = await thrown(() => tryUse("ask"));
  check(
    `after $${DAILY_SPEND_CAP_USD} spent today, every feature is refused`,
    capped instanceof LimitError && /today's Claude limit/.test(capped.message),
    describe(capped),
  );

  // Two at once: the last free place can't be taken twice.
  await reset();
  const chat = LIMITS.chat;
  const results = await Promise.allSettled(Array.from({ length: chat.perMinute + 1 }, () => tryUse("chat")));
  const allowed = results.filter((r) => r.status === "fulfilled").length;
  const refused = results.filter((r) => r.status === "rejected" && r.reason instanceof LimitError).length;
  check(
    `${chat.perMinute + 1} chat messages at the same instant: exactly ${chat.perMinute} allowed`,
    allowed === chat.perMinute && refused === 1,
    `allowed ${allowed}, refused ${refused}`,
  );
} finally {
  await reset();
  const { rows } = await owner.query(`SELECT count(*)::int AS n FROM "ClaudeUsage" WHERE "userId" = $1`, [TEST_USER]);
  check("the test user's rows were cleaned up", rows[0].n === 0);
  await owner.end();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
