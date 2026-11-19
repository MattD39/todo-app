// Short names for what went wrong, sent along with every { error } message
// from the Claude features, so the browser can react to the kind of problem
// (for example, show a Sign in button for "signed_out") without reading the
// wording. Safe to use in the browser and the server.
export type ProblemCode =
  | "signed_out" // your login expired
  | "limit" // one of your limits (per minute, per day, daily spend): see usage.ts
  | "busy" // Claude is overloaded, or the app's account hit Claude's own rate limit
  | "budget" // the app's monthly Claude budget is used up
  | "claude_down" // Claude's servers are failing
  | "unreachable" // the server couldn't connect to Claude
  | "no_answer" // Claude answered, but not usefully (e.g. no steps)
  | "bad_input" // something missing or odd in the request (e.g. no title)
  | "stopped" // you pressed Stop
  | "unexpected"; // anything else (a bug, a bad API key): details in the server log

export const SIGNED_OUT_MESSAGE = "You've been signed out. Sign in again to use Claude.";
