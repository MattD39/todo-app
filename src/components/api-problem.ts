import { SIGNED_OUT_MESSAGE, type ProblemCode } from "@/lib/problems";

// Helpers for showing what went wrong with a Claude feature in the browser.

// A message to show, plus what kind of problem it was (when the server said).
export type Problem = { message: string; code?: ProblemCode };

export const OFFLINE_MESSAGE = "You're offline. Connect to the internet and try again.";

// True when the device knows it has no internet. (It can't always tell, so a
// request can still fail while this says false: see connectionProblem.)
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

// The problem when /api/chat or /api/ask didn't send back an answer.
export async function problemFrom(response: Response): Promise<Problem> {
  const data: unknown = await response.json().catch(() => null);
  if (typeof data === "object" && data !== null && "error" in data && typeof data.error === "string") {
    // The server's own explanation, and its code if it sent one.
    const code = "code" in data && typeof data.code === "string" ? (data.code as ProblemCode) : undefined;
    return { message: data.error, code };
  }
  // A redirect (to /login) or 401 really is a login problem.
  if (response.redirected || response.status === 401) return { message: SIGNED_OUT_MESSAGE, code: "signed_out" };
  // Anything else is a crash on the server: the details are in the server log.
  return { message: "Something went wrong on the server. If it keeps happening, let the app owner know." };
}

// The problem when a request didn't get through at all (no reply).
export function connectionProblem(): Problem {
  if (isOffline()) return { message: OFFLINE_MESSAGE };
  return { message: "Couldn't connect. Check your internet connection and try again." };
}

// When fewer than this many uses are left today, a small note says so.
const LOW_LEFT = 5;

// "3 chat messages left today." when you're close to a daily limit, "" otherwise.
// `one` / `many`: what it's called, e.g. "chat message" / "chat messages".
export function leftTodayNote(left: number | null | undefined, one: string, many: string): string {
  if (left === null || left === undefined || !Number.isFinite(left) || left > LOW_LEFT) return "";
  if (left <= 0) return `That was your last ${one} for today. More at midnight.`;
  return `${left} ${left === 1 ? one : many} left today.`;
}

// The X-Left-Today header from /api/chat or /api/ask, as a number (null if missing).
export function leftTodayFrom(response: Response): number | null {
  const raw = response.headers.get("X-Left-Today");
  const left = raw === null ? NaN : Number(raw);
  return Number.isFinite(left) ? left : null;
}
