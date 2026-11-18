import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseConfig } from "@/lib/supabase/config";

// Pages anyone can open without being signed in.
const PUBLIC_PATHS = ["/login"];

// Runs before every page request. Two jobs:
// 1. Keep the Supabase login fresh. Login tokens expire after about an hour; this
//    renews them and sends the new cookie back to the browser.
// 2. Send signed-out visitors to /login. This is a quick first check only.
//    The real protection is getCurrentUser() in src/lib/auth.ts, which every
//    page and database query goes through.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url, key } = supabaseConfig();

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        // Stops shared caches (like Vercel's CDN) from storing a response that carries login cookies.
        Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
      },
    },
  });

  // Checks the login token (and refreshes it if it has expired).
  const { data } = await supabase.auth.getClaims();

  // Server actions (form buttons like Sign in / Sign out) expect a reply from the
  // action itself, so redirecting them breaks the button ("An unexpected response
  // was received from the server"). Let them through with the refreshed cookie;
  // actions that touch data check the user themselves via getCurrentUser().
  if (request.headers.has("next-action")) {
    return response;
  }

  const signedIn = Boolean(data?.claims?.sub);
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));

  if (!signedIn && path.startsWith("/api/")) {
    // The browser's code calls these, not a person, so a redirect to the login
    // page would just look like a strange reply. Say "not signed in" instead.
    const denied = NextResponse.json(
      { error: "Your login has expired. Reload the page and sign in." },
      { status: 401 },
    );
    response.cookies.getAll().forEach((cookie) => denied.cookies.set(cookie));
    return denied;
  }
  if (!signedIn && !isPublic) {
    return redirectKeepingCookies(request, response, "/login");
  }
  if (signedIn && path === "/login") {
    return redirectKeepingCookies(request, response, "/");
  }
  return response;
}

// A redirect that still carries any refreshed or cleared login cookies.
function redirectKeepingCookies(request: NextRequest, from: NextResponse, to: string) {
  const redirect = NextResponse.redirect(new URL(to, request.url));
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  from.headers.forEach((value, name) => {
    if (name.toLowerCase() === "cache-control") redirect.headers.set(name, value);
  });
  return redirect;
}

export const config = {
  // Skip Next.js's own files, the favicon, images, the app icons + manifest, and
  // the service worker + offline page, so they load without a login check. (A
  // phone fetches these while signed out, e.g. when adding the app to the home
  // screen or installing the offline page.)
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon$|apple-icon$|manifest\\.webmanifest$|sw\\.js$|offline\\.html$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
