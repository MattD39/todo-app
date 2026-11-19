import { SIGNED_OUT_MESSAGE } from "@/lib/problems";

// The message to show when /api/chat or /api/ask didn't send back an answer.
export async function problemMessage(response: Response): Promise<string> {
  const data: unknown = await response.json().catch(() => null);
  if (typeof data === "object" && data !== null && "error" in data && typeof data.error === "string") {
    return data.error; // the server's own explanation
  }
  // A redirect (to /login) or 401 really is a login problem.
  if (response.redirected || response.status === 401) return SIGNED_OUT_MESSAGE;
  // Anything else is a crash on the server: the details are in the server log.
  return "Something went wrong on the server. If it keeps happening, let the app owner know.";
}
