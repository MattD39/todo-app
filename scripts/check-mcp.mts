//
// Checks the MCP server (what Claude connects to) works and stays safe.
//
// Run with: npm run check:mcp
//
// Free: no Claude calls, and you don't need to sign in.
// Part 1 checks the sign-in protection with the real server code: no pass,
//   fake passes and forged passes are all refused, and the public "where to
//   sign in" details are right.
// Part 2 sends real MCP requests through the real tools for a MADE-UP test
//   user (not you), as if that user had signed in: add, list, change, clear,
//   tick off, including blank ("") values. (Sign-in itself is Part 1's job,
//   so here the test user's pass is accepted directly.)
// Part 3 checks safety: the test user can't see or change a second made-up
//   person's task, even knowing its real id. The database rules hold on this
//   route too.
// Part 4 checks the change limits: 20 changes a minute and 200 a day per
//   person; reading is never limited, and changes refused for bad input don't
//   count.
// Only the two made-up people's rows are created and deleted (at the start
// and the end); your own tasks are never touched or shown. Exits with an
// error if any check fails.

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
const { createMcpHandler, withMcpAuth } = await jiti.import<typeof import("mcp-handler")>("mcp-handler");
const tools = await jiti.import<typeof import("../src/lib/mcp/tools.ts")>(path.join(root, "src/lib/mcp/tools.ts"));
const mcpAuth = await jiti.import<typeof import("../src/lib/mcp/auth.ts")>(path.join(root, "src/lib/mcp/auth.ts"));
const route = await jiti.import<typeof import("../src/app/api/mcp/route.ts")>(path.join(root, "src/app/api/mcp/route.ts"));
const metadataRoute = await jiti.import<{ GET: (req: Request) => Response }>(
  path.join(root, "src/app/.well-known/oauth-protected-resource/[[...resource]]/route.ts"),
);
const { addDays, nowIn } = await jiti.import<typeof import("../src/lib/dates.ts")>(path.join(root, "src/lib/dates.ts"));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `\n      ${detail}` : ""}`);
}

// ─── Sending MCP requests ────────────────────────────────────────────────────

type Handler = (req: Request) => Promise<Response> | Response;

function mcpRequest(body: object, token?: string): Request {
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// The JSON-RPC reply inside an MCP response (sent as JSON or as one SSE event).
async function reply(res: Response): Promise<Record<string, unknown>> {
  const body = await res.text();
  const data = body.trimStart().startsWith("{")
    ? body
    : body
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
  return JSON.parse(data);
}

let nextId = 1;
async function listTools(handler: Handler, token: string) {
  const res = await handler(mcpRequest({ jsonrpc: "2.0", id: nextId++, method: "tools/list" }, token));
  const { result } = (await reply(res)) as { result: { tools: { name: string; annotations?: Record<string, boolean> }[] } };
  return result.tools;
}

// Calls a tool; returns its text and whether it reported a problem.
async function callTool(handler: Handler, token: string, name: string, args: object = {}) {
  const res = await handler(
    mcpRequest({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, token),
  );
  const message = await reply(res);
  const result = message.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
  const error = message.error as { message?: string } | undefined;
  const text = result?.content?.map((c) => c.text ?? "").join("\n") ?? error?.message ?? "";
  return { text, isError: Boolean(result?.isError || error) };
}

// ─── Part 1: sign-in protection (real server code) ───────────────────────────
console.log("Part 1: sign-in protection (the real /api/mcp and its checks)\n");

const tasksList = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const noPass = await route.POST(mcpRequest(tasksList));
check(
  "a request with no login pass is refused (401) and told where to sign in",
  noPass.status === 401 && /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/api\/mcp"/.test(noPass.headers.get("www-authenticate") ?? ""),
  `status ${noPass.status}, ${noPass.headers.get("www-authenticate")}`,
);
const fake = await route.POST(mcpRequest(tasksList, "not-a-real-pass"));
check("a made-up login pass is refused (401)", fake.status === 401, `status ${fake.status}`);

// A pass that looks real (right shape, all the right details) but wasn't
// signed by this app's Supabase project.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const forged = [
  b64({ alg: "HS256", typ: "JWT" }),
  b64({
    sub: "00000000-0000-4000-8000-000000000001",
    role: "authenticated",
    aud: "authenticated",
    client_id: "sneaky-app",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
  Buffer.from("not the real signature").toString("base64url"),
].join(".");
check("a forged pass (right shape, wrong signature) is refused", (await mcpAuth.verifyMcpToken(new Request("http://x"), forged)) === undefined);
check("no pass at all gets nobody", (await mcpAuth.verifyMcpToken(new Request("http://x"), undefined)) === undefined);

const metadata = (await metadataRoute
  .GET(new Request("http://localhost:3000/.well-known/oauth-protected-resource/api/mcp"))
  .json()) as { resource?: string; authorization_servers?: string[] };
check(
  "the public sign-in details name this server and this app's Supabase sign-in",
  metadata.resource === "http://localhost:3000/api/mcp" &&
    metadata.authorization_servers?.[0] === `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`,
  JSON.stringify(metadata).replace(/https:\/\/[a-z0-9]+\.supabase\.co/g, "https://<project>.supabase.co"),
);

// ─── Part 2: the tools, for a made-up test user ──────────────────────────────
console.log("\nPart 2: the tools, for a made-up test user (cleaned up afterwards)\n");

const TEST_USER = "00000000-0000-4000-8000-00000000c0de"; // nobody real
const OTHER_USER = "00000000-0000-4000-8000-00000000c0df"; // a second made-up person, for Part 3
const TEST_PASS = "check-mcp-test-pass";
const TIME_ZONE = "America/Halifax";
// The real tools behind the real "sign in first" wrapper, but with the test
// user's pass accepted directly (Part 1 covers real passes).
const handler = withMcpAuth(
  createMcpHandler(
    (server) => {
      tools.registerTools(server);
      tools.registerChangeTools(server);
    },
    { serverInfo: { name: "todo-check", version: "0" } },
  ),
  async (_req: Request, token?: string) =>
    token === TEST_PASS
      ? { token, clientId: "check-mcp", scopes: [], extra: { userId: TEST_USER, email: null, timeZone: TIME_ZONE } }
      : undefined,
  { required: true },
);
const call = (name: string, args: object = {}) => callTool(handler, TEST_PASS, name, args);
const idIn = (text: string) => text.match(/id: ([0-9a-f-]{36})/)?.[1] ?? "";

const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
await owner.connect();
// Only ever the two made-up people's rows (steps and ticks go with their tasks).
async function cleanUp() {
  for (const user of [TEST_USER, OTHER_USER]) {
    await owner.query(`DELETE FROM "Task" WHERE "userId" = $1`, [user]);
    await owner.query(`DELETE FROM "Category" WHERE "userId" = $1`, [user]);
    await owner.query(`DELETE FROM "ClaudeUsage" WHERE "userId" = $1`, [user]);
  }
}
// The test user's counted uses (for the change limits in Part 4).
async function resetUsage() {
  await owner.query(`DELETE FROM "ClaudeUsage" WHERE "userId" = $1`, [TEST_USER]);
}
async function addPastUses(count: number, feature: string, costUsd = 0) {
  await owner.query(
    `INSERT INTO "ClaudeUsage" ("id", "userId", "feature", "startedAt", "costUsd")
     SELECT gen_random_uuid(), $1, $2::"ClaudeFeature", now() - interval '61 seconds', $3 FROM generate_series(1, $4)`,
    [TEST_USER, feature, costUsd, count],
  );
}

try {
  await cleanUp();

  const all = await listTools(handler, TEST_PASS);
  const names = all.map((t) => t.name).sort();
  const expected = [
    "add_task",
    "clear_fields",
    "complete_task",
    "get_task",
    "list_finished",
    "list_open_tasks",
    "save_category",
    "update_task",
  ];
  check("exactly the 8 planned tools, and no delete tool", JSON.stringify(names) === JSON.stringify(expected), names.join(", "));
  const readTools = ["get_task", "list_finished", "list_open_tasks"];
  check(
    "reading tools are marked read-only; changing tools aren't (so Claude apps ask first)",
    all.every((t) => (t.annotations?.readOnlyHint === true) === readTools.includes(t.name)),
  );

  const today = nowIn(TIME_ZONE).today;
  const tomorrow = addDays(today, 1);

  const empty = await call("list_open_tasks");
  check("a new user sees no tasks, in their own time zone", /none\./.test(empty.text) && empty.text.includes(TIME_ZONE), empty.text);

  // Blank values ("") for optional fields count as "not given".
  const added = await call("add_task", {
    title: "Check task",
    due_date: tomorrow,
    due_time: "14:30",
    category: "check-cat",
    priority: "",
    repeat: "",
    notes: "",
  });
  const id = idIn(added.text);
  check(
    "add_task adds it; blank optional values are ignored (medium priority, doesn't repeat)",
    !added.isError && !!id && /Tomorrow/.test(added.text) && /2:30 PM/.test(added.text) && /medium priority/.test(added.text) && !/repeats/.test(added.text),
    added.text,
  );

  const upcoming = await call("list_open_tasks", { show: "upcoming", category: "CHECK-CAT" });
  const todayOnly = await call("list_open_tasks", { show: "today", category: "" });
  check(
    "list_open_tasks filters by when and by category (capitals don't matter)",
    upcoming.text.includes(id) && !todayOnly.text.includes(id),
    `${upcoming.text}\n${todayOnly.text}`,
  );

  const priority = await call("update_task", { task_id: id, priority: "high", title: "" });
  check(
    "update_task changes only what's sent (a blank title is ignored)",
    !priority.isError && /high priority/.test(priority.text) && /Check task/.test(priority.text),
    priority.text,
  );
  const moved = await call("update_task", { task_id: id, due_date: addDays(today, 2) });
  check("moving the day keeps the time", !moved.isError && /2:30 PM/.test(moved.text), moved.text);
  const same = await call("update_task", { task_id: id, priority: "high" });
  check("asking for what the task already has: refused, nothing would change", same.isError && /nothing would change/.test(same.text), same.text);
  const noDate = await call("add_task", { title: "Time only", due_time: "09:00" });
  check("a time with no date is refused", noDate.isError && /needs a due date/.test(noDate.text), noDate.text);

  const cleared = await call("clear_fields", { task_id: id, fields: ["due_time"] });
  check("clear_fields removes only the time (the day stays)", !cleared.isError && !/2:30 PM/.test(cleared.text) && /due /.test(cleared.text), cleared.text);

  const details = await call("get_task", { task_id: id });
  check("get_task shows the task in full", !details.isError && /Title: Check task/.test(details.text) && /Category: check-cat/i.test(details.text), details.text);

  const done = await call("complete_task", { task_id: id });
  check("complete_task ticks it off", !done.isError && /now finished/.test(done.text), done.text);
  const afterDone = await call("update_task", { task_id: id, priority: "low" });
  check("a finished task can't be changed", afterDone.isError && /already finished/.test(afterDone.text), afterDone.text);
  const finished = await call("list_finished", { days: "" });
  check("list_finished shows it (blank days = the default 7)", finished.text.includes(id), finished.text);

  const repeating = await call("add_task", { title: "Check repeat", due_date: today, repeat: "weekly" });
  const repeatId = idIn(repeating.text);
  const ticked = await call("complete_task", { task_id: repeatId });
  check(
    "ticking a weekly task moves it on a week (in the user's time zone)",
    !ticked.isError && ticked.text.includes(addDays(today, 7)),
    ticked.text,
  );

  // Saved categories (g4). "check-cat" above was a one-off (nothing saved yet).
  check(
    "a category that isn't saved: the answer says it's a one-off and to ask \"Save it to your list?\"",
    /one-off/.test(added.text) && /Save it to your list\?/.test(added.text) && /save_category/.test(added.text),
    added.text,
  );
  const savedCat = async (name: string) =>
    (await owner.query(`SELECT name, saved FROM "Category" WHERE "userId" = $1 AND lower(name) = lower($2)`, [TEST_USER, name]))
      .rows;
  check("…and it really is a one-off in the database", (await savedCat("check-cat"))[0]?.saved === false);
  const saveIt = await call("save_category", { name: "CHECK-CAT" });
  const rows = await savedCat("check-cat");
  check(
    "save_category saves the one-off (keeping its own capitals), and its task keeps it",
    !saveIt.isError && rows.length === 1 && rows[0].saved === true && rows[0].name === "check-cat",
    `${saveIt.text} ${JSON.stringify(rows)}`,
  );
  const again = await call("save_category", { name: "Check-Cat" });
  check("saving it again: refused, it's already on the list", again.isError && /already on your list/.test(again.text), again.text);
  const usesSaved = await call("add_task", { title: "Uses saved", category: "Check-cat" });
  check(
    "a saved category (any capitals): no question asked",
    !usesSaved.isError && !/one-off/.test(usesSaved.text) && /category: check-cat/.test(usesSaved.text),
    usesSaved.text,
  );
  const moveCat = await call("update_task", { task_id: idIn(usesSaved.text), category: "Brand new" });
  check(
    "update_task to a category that isn't saved asks too",
    !moveCat.isError && /“Brand new” isn't one of the user's saved categories/.test(moveCat.text),
    moveCat.text,
  );
  const listed = await call("list_open_tasks");
  check(
    "list_open_tasks lists the saved categories (not the one-offs)",
    /Saved categories \(the user's list\): check-cat\./.test(listed.text),
    listed.text,
  );

  // ─── Part 3: safety ────────────────────────────────────────────────────────
  console.log("\nPart 3: safety (another person's task)\n");

  // A task belonging to a second made-up person, put straight into the
  // database (as the owner, for setting up). The test user knows its real id.
  const { rows: made } = await owner.query(
    `INSERT INTO "Task" (id, "userId", title, "dueDate", "updatedAt")
     VALUES (gen_random_uuid(), $1, 'Someone else''s private task', current_date + 1, now())
     RETURNING id, "updatedAt", done`,
    [OTHER_USER],
  );
  const theirs = made[0];
  const peek = await call("get_task", { task_id: theirs.id });
  const change = await call("update_task", { task_id: theirs.id, title: "Hacked" });
  const tick = await call("complete_task", { task_id: theirs.id });
  const wipe = await call("clear_fields", { task_id: theirs.id, fields: ["due_date"] });
  check(
    "with another person's real task id, the test user gets \"no task with that id\" (can't read, change, tick or clear it)",
    [peek, change, tick, wipe].every((r) => r.isError && /no task with that id/.test(r.text)),
    [peek, change, tick, wipe].map((r) => r.text).join(" / "),
  );
  const { rows: after } = await owner.query(`SELECT title, "updatedAt", done FROM "Task" WHERE id = $1`, [theirs.id]);
  check(
    "and their task is untouched",
    after[0].title === "Someone else's private task" &&
      after[0].updatedAt.getTime() === theirs.updatedAt.getTime() &&
      after[0].done === theirs.done,
  );
  const list = await call("list_open_tasks");
  const finishedList = await call("list_finished", { days: 31 });
  check(
    "the test user's lists never include another person's task",
    !list.text.includes(theirs.id) && !list.text.includes("Someone else") && !finishedList.text.includes(theirs.id),
  );

  // ─── Part 4: change limits ─────────────────────────────────────────────────
  console.log("\nPart 4: change limits (20 a minute, 200 a day; reading unlimited)\n");

  await resetUsage();
  for (let i = 0; i < 3; i++) await call("add_task", { title: "Refused", due_time: "09:00" });
  const { rows: counted } = await owner.query(`SELECT count(*)::int AS n FROM "ClaudeUsage" WHERE "userId" = $1`, [TEST_USER]);
  check("changes refused for bad input don't count towards the limits", counted[0].n === 0, `counted ${counted[0].n}`);

  let allowed = 0;
  for (let i = 1; i <= 20; i++) {
    const r = await call("add_task", { title: `Limit ${i}` });
    if (!r.isError) allowed++;
  }
  const twentyFirst = await call("add_task", { title: "Limit 21" });
  check(
    "20 changes in a minute are fine; the 21st is refused with a real wait",
    allowed === 20 && twentyFirst.isError && /Wait about \d+ seconds?/.test(twentyFirst.text),
    `allowed ${allowed}; 21st: ${twentyFirst.text}`,
  );
  const stillReads = await call("list_open_tasks");
  check("reading still works after the change limit is reached", !stillReads.isError && /Limit 20/.test(stillReads.text));

  await resetUsage();
  await addPastUses(200, "mcp_change");
  const dayFull = await call("add_task", { title: "One too many" });
  check(
    "after 200 changes today, the next is refused until midnight",
    dayFull.isError && /today's 200 changes through Claude\. More at midnight/.test(dayFull.text),
    dayFull.text,
  );

  await resetUsage();
  await addPastUses(1, "chat", 0.15); // the Chat tab's daily spending cap is used up
  const capped = await call("add_task", { title: "Spending cap test" });
  check("the Chat tab's spending cap doesn't block changes through Claude (they cost nothing)", !capped.isError, capped.text);
} finally {
  await cleanUp();
  const { rows } = await owner.query(`SELECT count(*)::int AS n FROM "Task" WHERE "userId" IN ($1, $2)`, [
    TEST_USER,
    OTHER_USER,
  ]);
  check("the made-up people's tasks were cleaned up", rows[0].n === 0);
  await owner.end();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
