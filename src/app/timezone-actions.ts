"use server";

import { getSignedInUser } from "@/lib/auth";
import { isValidTimeZone } from "@/lib/dates";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Saves your time zone on your account (Supabase "user metadata"), so things
// that have no browser cookie, like Claude through the MCP server, still know
// what "today" means for you. Called by TimeZoneSync when the browser's time
// zone isn't the saved one. Only ever changes your own account.
export async function saveTimeZone(timeZone: unknown): Promise<void> {
  if (typeof timeZone !== "string" || !isValidTimeZone(timeZone)) return;
  const user = await getSignedInUser();
  if (!user || user.timeZone === timeZone) return;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ data: { time_zone: timeZone } });
  if (error) {
    console.error("Couldn't save the time zone", error.message);
    return;
  }
  // A fresh login cookie carries the new time zone, so this isn't saved
  // again on the next page.
  await supabase.auth.refreshSession();
}
