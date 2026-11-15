import { Suspense } from "react";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { signOut } from "./login/actions";

// Phase 2 placeholder: proves sign-in, the database connection and per-user
// filtering all work. The real Today view replaces this in Phase 3.
export default function Home() {
  return (
    <main className="mx-auto max-w-[640px] px-4 pt-4">
      <h1 className="font-display text-[1.75rem] leading-tight font-bold tracking-tight">Today</h1>
      {/* Reading the login cookie happens per request, so it streams in behind a boundary. */}
      <Suspense fallback={<div className="mt-6 text-muted">Loading…</div>}>
        <Account />
      </Suspense>
    </main>
  );
}

async function Account() {
  const user = await getCurrentUser();
  const openTasks = await db.task.count({ where: { userId: user.id, done: false } });

  return (
    <>
      <div className="mt-6 rounded-xl border border-dashed border-line p-4 text-center text-muted">
        Signed in and connected to the database. You have <b className="text-ink">{openTasks}</b> open{" "}
        {openTasks === 1 ? "task" : "tasks"}. Tasks arrive in Phase 3.
      </div>
      <form action={signOut} className="mt-4 flex items-center justify-between gap-3 text-[0.9rem] text-muted">
        <span className="min-w-0 truncate">{user.email}</span>
        <button type="submit" className="rounded-xl border border-line bg-surface px-3.5 py-2 font-bold text-ink">
          Sign out
        </button>
      </form>
    </>
  );
}
