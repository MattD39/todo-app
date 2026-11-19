import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { createSupabaseServerClient } from "./supabase/server";

export type CurrentUser = {
  id: string;
  email: string | null;
};

// The one place the app finds out who is signed in. Every page and every
// database read or write must start here and filter by the returned id.
// Signed-out visitors are sent to /login.
// cache() remembers the answer for the rest of the same request, so calling
// this from many places (every function in tasks.ts) only checks once.
export const getCurrentUser = cache(async (): Promise<CurrentUser> => {
  const user = await getSignedInUser();
  if (!user) redirect("/login");
  return user;
});

// The same check, but answers null for a signed-out visitor instead of
// sending them to /login. For the Claude features and Chat saving, which
// say "you've been signed out" instead, so nothing typed on screen is lost.
export const getSignedInUser = cache(async (): Promise<CurrentUser | null> => {
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
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
});
