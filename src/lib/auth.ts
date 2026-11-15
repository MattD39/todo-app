import "server-only";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "./supabase/server";

export type CurrentUser = {
  id: string;
  email: string | null;
};

// The one place the app finds out who is signed in. Every page and every
// database read or write must start here and filter by the returned id.
// Signed-out visitors are sent to /login.
export async function getCurrentUser(): Promise<CurrentUser> {
  const supabase = await createSupabaseServerClient();
  // getClaims() verifies the login token's signature, so it can't be faked
  // by editing the cookie.
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) {
    redirect("/login");
  }
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}
