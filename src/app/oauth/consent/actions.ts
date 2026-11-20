"use server";

import { redirect } from "next/navigation";
import { getSignedInUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type DecisionState = { error: string | null };

// Allow or Deny on the "Allow Claude?" page. Supabase records the choice and
// says where to send you next: back to Claude, with a one-time code (Allow,
// which Claude swaps for a login pass) or with "access denied" (Deny).
// A server action, so Next.js checks the request came from this app's own
// page: another website can't press Allow for you.
export async function decide(_prev: DecisionState, formData: FormData): Promise<DecisionState> {
  const id = String(formData.get("authorization_id") ?? "");
  const allow = formData.get("decision") === "allow";
  if (!id) return { error: "This request is missing its details. Go back to Claude and try connecting again." };

  if (!(await getSignedInUser())) {
    redirect(`/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${id}`)}`);
  }

  const supabase = await createSupabaseServerClient();
  // skipBrowserRedirect: we're on the server, so we redirect ourselves below.
  const { data, error } = allow
    ? await supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true })
    : await supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
  if (error || !data?.redirect_url) {
    return { error: "That didn't work: the request may have expired. Go back to Claude and try connecting again." };
  }
  redirect(data.redirect_url);
}
