"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type SignInState = { error: string | null; email: string };

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "Enter your email and password.", email };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Supabase uses one message for "no such user" and "wrong password" on purpose,
    // so this doesn't reveal which emails have accounts.
    const message =
      error.code === "invalid_credentials"
        ? "That email and password don't match."
        : error.code === "email_not_confirmed"
          ? "Confirm your email first (check your inbox), then try again."
          : error.status === 429
            ? "Too many attempts. Wait a minute and try again."
            : "Couldn't sign in. Check your connection and try again.";
    return { error: message, email };
  }

  redirect("/");
}

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  // "local" signs out only this device. Supabase's default ("global") ends your
  // login on every device, so signing out on the computer would quietly log
  // the phone app out too.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
