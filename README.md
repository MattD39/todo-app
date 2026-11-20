# To-Do: a task app that Claude can use

A personal to-do app (web + iPhone home-screen app) with Claude built in, and an **MCP server** so people can manage their tasks from inside Claude itself: claude.ai, the Claude iPhone app, Claude Desktop or Claude Code.

**Live:** https://mattd-tasks.vercel.app (sign-ups are currently closed)

_Screenshots coming soon._

> **How it was built:** I designed and directed this project with **Claude Code** (Anthropic's AI coding agent). I set the goals, made the product and security decisions, reviewed each step and tested every feature by hand. Claude Code wrote the code to my plans, one small step at a time.
>
> I'm not a software developer by background. This project is how I learned to build with AI agents: planning features, testing every step, and catching the bugs the AI missed, like a Stop button that secretly re-sent messages, and time zone errors in the MCP server.

---

## At a glance

|                  |                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it does** | Tasks with due dates and times, priorities, categories, steps and repeats; Today, Upcoming, Calendar and Done views; installs on iPhone as a home-screen app                                |
| **AI features**  | Claude suggests steps for a task, answers questions about a task, and chats about your whole list, adding, changing and ticking off tasks when you clearly ask (with Undo)                  |
| **MCP server**   | Connect your own Claude to your list: 7 tools (read, add, change, tick off; no delete), standard OAuth sign-in, per-user database isolation                                                 |
| **Safety**       | Every user's data is isolated by the database itself (Postgres row-level security); per-user limits on Claude use and on changes; prompt-injection defences; automated checks for all of it |
| **Stack**        | Next.js 16 (React 19, TypeScript), Tailwind CSS 4, Supabase (Postgres + Auth), Prisma 7, Claude API (Claude Haiku 5.5), MCP (`mcp-handler`), Vercel                                         |

---

## The MCP server: use your to-do list from inside Claude

[MCP (Model Context Protocol)](https://modelcontextprotocol.io) is the open standard for giving AI assistants new tools. This app runs an MCP server at `/api/mcp`, so anyone with an account can say to their own Claude things like _"What's due this week?"_ or _"Add 'book dentist' for Friday at 9"_ and Claude does it in their list.

### Connecting it (claude.ai)

1. Go to **Settings → Plugins → Connectors**, then **Browse plugins → Add custom connector**, and enter the URL `https://mattd-tasks.vercel.app/api/mcp`. (Menu names can vary by Claude plan.)
2. Claude sends you to the app's own **"Allow Claude to use your To-Do list?"** page. Sign in, check what it may do, press **Allow**.
3. In any chat, switch on the To-Do connector. It also works in the Claude iPhone app.

### The tools

| Tool              | What it does                                                                    | Type   |
| ----------------- | ------------------------------------------------------------------------------- | ------ |
| `list_open_tasks` | Open tasks, filterable by today / overdue / upcoming / no date, and by category | read   |
| `get_task`        | One task in full: notes and steps                                               | read   |
| `list_finished`   | What you finished in the last 1–31 days                                         | read   |
| `add_task`        | Add a task (date, time, priority, category, repeat, notes)                      | change |
| `update_task`     | Change only the fields asked for (moving the day keeps the time)                | change |
| `clear_fields`    | Remove a date, time, category or repeat, only when explicitly asked             | change |
| `complete_task`   | Tick off (a repeating task moves to its next date)                              | change |

There is deliberately **no delete tool**. Change tools are marked as changing data, so Claude apps ask the user before using them. All dates use each user's own time zone.

### How it's kept safe

```
 Claude app ──(1) "sign in first"──▶ /api/mcp ──▶ points to Supabase sign-in
     │                                                      │
     │◀─(2) sign in + "Allow?" page (this app) ◀────────────┘
     │
     └─(3) every request carries a signed login pass ──▶ /api/mcp
                                                             │ verify pass
                                                             ▼
                              tools run AS that user ──▶ Postgres row-level security
                                                          (only their rows exist for them)
```

- **Standard OAuth 2.1 sign-in.** Supabase Auth issues the login passes. The app's own consent page shows which app is asking, which account, what it can do and where you'll be sent back. A protected-resource metadata endpoint (`/.well-known/oauth-protected-resource`) tells Claude where to sign in.
- **Every request is verified.** The pass must be signed by this project, unexpired, issued to an app the user allowed, and still valid with Supabase (revoked access stops at once).
- **The database enforces isolation.** Each tool runs as the signed-in user through the same code as the app's own buttons. Postgres row-level security means even a bug can't return someone else's rows: another person's task id behaves exactly like one that doesn't exist.
- **Same rules as the app.** The tools reuse the in-app Chat tab's validation, so Claude can only change the fields it was asked to change.
- **Limits.** 20 changes a minute and 200 a day per person, so a confused Claude conversation can't flood a list. Reading is unlimited.
- **Prompt-injection defence.** Task text is always marked as the user's own words, never instructions.

---

## Claude inside the app

- **Suggest steps** breaks a task into a checklist.
- **Ask Claude** answers a question about one task, streamed word by word.
- **Chat tab:** talk to Claude about your whole list. It can add, change, clear or tick off tasks, shown as ✓ lines with **Undo**. It only acts on clear requests (a vague "ok?" is not a yes), never re-offers something you undid, keeps replying while you're on another tab, and never deletes.
- **Per-user limits** (per minute, per day, and a daily spending cap measured from real token usage), with friendly messages for every kind of failure: offline, signed out (sign back in without losing what you typed), Claude busy, and so on.

## Testing

Besides hand-testing every feature, the project has automated checks:

| Command                    | What it proves                                                                                                                            | Cost                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `npm run test:rls`         | The database itself keeps users apart: no reading, changing, creating or handing over other users' rows, even with no filter in the query | free                |
| `npm run check:mcp`        | MCP sign-in refuses missing, fake and forged passes; every tool works; another user's task can't be touched even by id; change limits     | free                |
| `npm run check:limits`     | Claude usage limits and spending cap, including two requests at the same instant                                                          | free                |
| `npm run check:errors`     | Each kind of Claude failure gets the right message                                                                                        | free                |
| `npm run check:chat-tools` | Real Claude requests: only asked-for fields change, vague replies change nothing, injected instructions in task text are ignored          | fractions of a cent |
| `npm run check:claude`     | A basic live Claude call and an injection test                                                                                            | fractions of a cent |

The database checks use made-up test users and clean up after themselves.

## Running it locally

Needs Node.js 20+, a Supabase project and an Anthropic API key. Create `.env.local` with:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
DATABASE_URL=...      # pooled connection (the app)
DIRECT_URL=...        # direct connection (migrations only)
ANTHROPIC_API_KEY=...
```

Then:

```bash
npm install
npx prisma migrate deploy
npm run dev            # http://localhost:3000
```

For the MCP server, turn on Supabase's **OAuth 2.1 server** (Authentication → OAuth Server) with the authorization path `/oauth/consent` and dynamic client registration enabled.

## Project layout

```
src/app/            pages (Today, Upcoming, Calendar, Done, Chat), API routes, OAuth consent page
src/app/api/mcp/    the MCP server
src/lib/tasks.ts    all task reads and writes (always as the signed-in user)
src/lib/ai.ts       Claude features: prompts, tools, streaming
src/lib/mcp/        MCP sign-in checks and tools
src/lib/usage.ts    per-user limits
prisma/             database schema and migrations (including the row-level security rules)
scripts/, tests/    the automated checks above
```
