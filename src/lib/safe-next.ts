// Where to go after signing in ("?next=/oauth/consent?..."), only if it's a
// page of this app. Anything else (another website, "//evil.com", odd
// characters) gives null, so a link can't use the sign-in page to send you
// somewhere else. Safe to use in the browser, the proxy and the server.
export function safeNext(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  // Must be a path on this site: "/" then a letter, digit or a few safe
  // characters, never "//" or "/\" (which browsers treat as another website).
  if (!/^\/(?![/\\])[\w\-./?=&%~+:@!$'()*,;]*$/.test(value)) return null;
  if (value === "/login" || value.startsWith("/login?")) return null;
  return value;
}
