import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { isValidTimeZone } from "./dates";
import { createSupabaseServerClient } from "./supabase/server";

export type CurrentUser = {
  id: string;
  email: string | null;
  // The time zone saved on the account (e.g. "America/Toronto"), or null if
  // not saved yet. See saveTimeZone in src/app/timezone-actions.ts.
  timeZone: string | null;
};

// The one place the app finds out who is signed in. Every page and every
// database read or write must start here and filter by the returned id.
// Signed-out visitors are sent to /login.
export async function getCurrentUser(): Promise<CurrentUser> {
  const user = await getSignedInUser();
  if (!user) redirect("/login");
  return user;
}

// The same check, but answers null for a signed-out visitor instead of
// sending them to /login. For the Claude features and Chat saving, which
// say "you've been signed out" instead, so nothing typed on screen is lost.
export async function getSignedInUser(): Promise<CurrentUser | null> {
  // A request from the MCP server (Claude connected to the app): who it is
  // was already checked from its login pass (see src/lib/mcp/auth.ts).
  return mcpUser.getStore() ?? userFromCookie();
}

// The browser's login cookie. cache() remembers the answer for the rest of
// the same request, so calling this from many places (every function in
// tasks.ts) only checks once.
const userFromCookie = cache(async (): Promise<CurrentUser | null> => {
  // Checking a login compares the token's expiry with the current time, so it
  // must run fresh on every visit, never ahead of time. connection() tells
  // Next.js to wait for the real request before running anything below.
  await connection();
  const supabase = await createSupabaseServerClient();
  // getClaims() verifies the login token's signature, so it can't be faked
  // by editing the cookie.
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null, timeZone: savedTimeZone(claims) };
});

// The time zone saved in the account's user metadata, if it's a real one.
// (The app's own login pass carries the metadata; passes given to Claude
// don't, so src/lib/mcp/auth.ts reads it from the account instead.)
export function savedTimeZone(claims: { user_metadata?: Record<string, unknown> }): string | null {
  const value = claims.user_metadata?.time_zone;
  return typeof value === "string" && isValidTimeZone(value) ? value : null;
}

// MCP requests carry a login pass (a token) instead of a cookie. Once the MCP
// server has checked it, it runs the tool "as" that user with this, so
// everything else (tasks.ts, the database rules) works exactly as for the
// app's own pages: only that user's tasks, nobody else's.
// (AsyncLocalStorage keeps the user attached to this one request only, even
// when many requests run at the same time.)
const mcpUser = new AsyncLocalStorage<CurrentUser>();

// Runs `work` as `user`. Only for src/lib/mcp/: `user` must come from a
// verified login pass, never from anything a request sends as plain data.
export function runAsVerifiedUser<T>(user: CurrentUser, work: () => Promise<T>): Promise<T> {
  return mcpUser.run(user, work);
}

// The MCP request's user, if this is one (null for the app's own pages).
export function getMcpUser(): CurrentUser | null {
  return mcpUser.getStore() ?? null;
}
