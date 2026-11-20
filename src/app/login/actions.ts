"use server";

import { redirect } from "next/navigation";
import { safeNext } from "@/lib/safe-next";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type SignInState = { error: string | null; email: string };

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const error = await trySignIn(email, password);
  if (error) return { error, email };
  // Back to where you were going (e.g. the "Allow Claude?" page), if it's a
  // page of this app; otherwise Today.
  redirect(safeNext(formData.get("next")) ?? "/");
}

// Signs in without leaving the page: the small sign-in box that opens when a
// Claude feature says you've been signed out. Nothing on screen is lost.
// Returns an error message, or null when signed in.
export async function signInHere(email: unknown, password: unknown): Promise<{ error: string | null }> {
  return { error: await trySignIn(String(email ?? "").trim(), String(password ?? "")) };
}

// Signs in (sets the login cookie). Returns a message to show, or null if it worked.
async function trySignIn(email: string, password: string): Promise<string | null> {
  if (!email || !password) return "Enter your email and password.";

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error) return null;
  // Supabase uses one message for "no such user" and "wrong password" on purpose,
  // so this doesn't reveal which emails have accounts.
  return error.code === "invalid_credentials"
    ? "That email and password don't match."
    : error.code === "email_not_confirmed"
      ? "Confirm your email first (check your inbox), then try again."
      : error.status === 429
        ? "Too many attempts. Wait a minute and try again."
        : "Couldn't sign in. Check your connection and try again.";
}

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  // "local" signs out only this device. Supabase's default ("global") ends your
  // login on every device, so signing out on the computer would quietly log
  // the phone app out too.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
