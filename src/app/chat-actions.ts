"use server";

import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { getSignedInUser } from "@/lib/auth";
import {
  applyChanges,
  cleanChanges,
  cleanUndos,
  undoChanges,
  type ChangeResult,
  type UndoResult,
} from "@/lib/chat-changes";
import type { ProblemCode } from "@/lib/problems";

// Signed out while Claude's reply was coming: say so, rather than jumping to
// the login page (which would lose the chat on screen).
const signedOut = (what: string) => ({
  error: `You've been signed out, so nothing was ${what}. Sign in again and try once more.`,
  code: "signed_out" as ProblemCode,
});

// Saves the changes Claude queued in the Chat tab, straight after its reply.
//
// The browser sends the changes back, and anything from a browser can be
// faked, so they're checked again here and saved through src/lib/tasks.ts:
// only your own tasks, with the same checks as the app's buttons. (So this
// can't do anything you couldn't do yourself by tapping.)
export async function applyChatChanges(
  input: unknown,
): Promise<{ error: string | null; code?: ProblemCode; results?: ChangeResult[] }> {
  try {
    if (!(await getSignedInUser())) return signedOut("saved");
    const changes = cleanChanges(input);
    if (!changes) return { error: "Those changes didn't look right, so nothing was saved." };
    const results = await applyChanges(changes);
    if (results.some((r) => r.ok)) refresh(); // the other tabs show the new list
    return { error: null, results };
  } catch (error) {
    // An expired login "throws" a redirect to /login; let Next.js carry it out.
    unstable_rethrow(error);
    console.error("Chat changes failed", error);
    return { error: "Couldn't save the changes. Check your connection and try again." };
  }
}

// Undoes changes Claude made in the Chat tab (one Undo button, or Undo all).
// Same rules as above: checked again, saved through src/lib/tasks.ts.
export async function undoChatChanges(
  input: unknown,
): Promise<{ error: string | null; code?: ProblemCode; results?: UndoResult[] }> {
  try {
    if (!(await getSignedInUser())) return signedOut("undone");
    const undos = cleanUndos(input);
    if (!undos) return { error: "That couldn't be undone." };
    const results = await undoChanges(undos);
    if (results.some((r) => r.ok)) refresh(); // the other tabs show the list as it is now
    return { error: null, results };
  } catch (error) {
    unstable_rethrow(error); // an expired login redirects to /login
    console.error("Chat undo failed", error);
    return { error: "Couldn't undo. Check your connection and try again." };
  }
}
