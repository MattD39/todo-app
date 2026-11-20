import "server-only";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createClient } from "@supabase/supabase-js";
import { runAsVerifiedUser, savedTimeZone } from "../auth";
import { supabaseConfig } from "../supabase/config";

// Who is using the MCP server.
//
// How signing in works (OAuth, the standard way apps get permission to act
// for you): when you connect Claude to the app, Claude sends you to Supabase,
// Supabase shows the app's own "Allow Claude?" page (src/app/oauth/consent),
// and once you allow it Claude gets a login pass for your account (an
// "access token"). Claude then sends that pass with every MCP request.
// Supabase is the "authorization server": it hands out and signs the passes.

// Where Claude finds Supabase's sign-in addresses (its "issuer" URL).
export function authServerUrl(): string {
  return `${supabaseConfig().url}/auth/v1`;
}

// Checks a login pass sent with an MCP request. Returns who it belongs to,
// or undefined (the request is then refused with "401: sign in first").
// Any signed-in user can connect their own Claude: it only ever sees their tasks.
export async function verifyMcpToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  const { url, key } = supabaseConfig();
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  // Checks the pass was signed by this app's Supabase project and hasn't
  // expired, so it can't be faked or edited.
  const { data, error } = await supabase.auth.getClaims(bearerToken);
  const claims = data?.claims;
  if (error || !claims?.sub || claims.role !== "authenticated") return undefined;
  // Only passes given to an app you allowed (they name that app, client_id).
  // A normal browser login cookie's token isn't accepted here.
  const clientId = (claims as Record<string, unknown>).client_id;
  if (typeof clientId !== "string" || !clientId) return undefined;

  // The account itself, fresh from Supabase, for the saved time zone: passes
  // given to apps like Claude don't carry the account's settings (user
  // metadata), unlike the app's own login. This also turns away a pass whose
  // access was revoked since it was issued.
  const { data: account, error: accountError } = await supabase.auth.getUser(bearerToken);
  if (accountError || account.user?.id !== claims.sub) return undefined;

  return {
    token: bearerToken,
    clientId,
    scopes: [],
    expiresAt: typeof claims.exp === "number" ? claims.exp : undefined,
    extra: {
      userId: claims.sub,
      email: typeof claims.email === "string" ? claims.email : null,
      timeZone: savedTimeZone({ user_metadata: account.user.user_metadata }),
    },
  };
}

// Runs a tool's work as the user whose pass came with the request, so
// tasks.ts and the database rules treat it exactly like that user's own
// app: only their tasks. Throws if there's no checked pass (can't happen
// behind withMcpAuth, but better safe).
export function asPassOwner<T>(authInfo: AuthInfo | undefined, work: () => Promise<T>): Promise<T> {
  const extra = authInfo?.extra as { userId?: unknown; email?: unknown; timeZone?: unknown } | undefined;
  if (typeof extra?.userId !== "string") throw new Error("Not signed in.");
  const email = typeof extra.email === "string" ? extra.email : null;
  const timeZone = typeof extra.timeZone === "string" ? extra.timeZone : null;
  return runAsVerifiedUser({ id: extra.userId, email, timeZone }, work);
}
