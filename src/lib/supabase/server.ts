import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseConfig } from "./config";

// A Supabase client for server code (pages, server actions). It reads and writes
// the login session through the browser's cookies.
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { url, key } = supabaseConfig();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Pages can't set cookies, only server actions can. That's fine:
          // src/proxy.ts refreshes the session cookie before each page loads.
        }
      },
    },
  });
}
