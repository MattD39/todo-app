"use client";

import { useSyncExternalStore } from "react";
import { applyChatChanges, undoChatChanges } from "@/app/chat-actions";
import type { ChangeResult, ChatChange, UndoResult } from "@/lib/chat-changes";
import { SIGNED_OUT_MESSAGE } from "@/lib/problems";
import { connectionProblem, isOffline, leftTodayFrom, OFFLINE_MESSAGE, problemFrom, type Problem } from "./api-problem";
import { onSignedIn } from "./signed-in";

// The Chat tab's "engine": the conversation, the reply being written, saving
// Claude's changes, Undo, Stop and Clear.
//
// It lives here, outside the Chat screen, so it keeps running while you're
// on another tab: a reply carries on, its changes are saved (and the other
// tabs reload their lists), and a dot appears on the Chat tab when it
// finishes while you're away. The Chat screen (chat.tsx) only shows this
// state and calls these functions. Closing the app still stops a reply,
// because the browser cuts the connection.
//
// Each message is sent to /api/chat with the conversation so far; the server
// adds your current task list itself and streams Claude's reply back, word by
// word. If Claude changed tasks (or wants to), the details come at the very
// end of the stream, after END_OF_TEXT.
//
// The conversation is kept in sessionStorage: it survives a reload, and is
// gone when the app is closed or you sign out. It's never saved on the server.

const STORAGE_KEY = "chat";

// Marks where Claude's text ends and the change details begin (same as the server's).
const END_OF_TEXT = "\u001e";

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  stopped?: boolean;
  changes?: ChatChange[]; // changes Claude queued with this reply (not saved by Claude)
  saving?: boolean;
  results?: ShownResult[]; // how saving them went: the only thing that says ✓ done
  failed?: Problem; // your messages only: it wasn't sent, and why (Try again / Edit under it)
};

// A saved change as shown in the chat, plus what happened when you pressed Undo.
export type ShownResult = ChangeResult & { undone?: boolean; undoError?: string };

export type ChatState = {
  messages: ChatMessage[];
  draft: string; // what's typed in the message box
  sending: boolean; // a reply is on its way (Stop is showing)
  savingNow: boolean; // Claude's changes are being saved: too late to stop
  undoing: boolean; // an Undo is being saved
  error: Problem | null; // shown under the chat (with a Sign in button when signed out)
  leftToday: number | null; // chat messages left today, after the last one sent
  unseen: boolean; // a reply finished while the Chat tab wasn't showing (the dot)
  chatShowing: boolean; // the Chat screen is on screen (then the tab shows no "…" or dot)
};

const EMPTY: ChatState = {
  messages: [],
  draft: "",
  sending: false,
  savingNow: false,
  undoing: false,
  error: null,
  leftToday: null,
  unseen: false,
  chatShowing: false,
};

let state: ChatState | null = null; // read from sessionStorage the first time it's needed
const listeners = new Set<() => void>();
let inProgress: AbortController | null = null; // the reply being written, if any
let openViews = 0; // how many Chat screens are showing right now (0 or 1)

function current(): ChatState {
  state ??= { ...EMPTY, messages: parseSaved(readSaved()) };
  return state;
}

function set(next: Partial<ChatState>) {
  const before = current();
  state = { ...before, ...next };
  if (next.messages && next.messages !== before.messages) save(next.messages);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The chat's state, for drawing it. Redraws whenever it changes. (The server
// has no sessionStorage, so it draws an empty chat first.)
export function useChat(): ChatState {
  return useSyncExternalStore(subscribe, current, () => EMPTY);
}

// Called by the Chat screen while it's showing: clears the dot, and while
// it's showing the tab shows no "…" and a finished reply doesn't add a dot. Returns the "stopped
// showing" function. (Switching tabs hides the screen, which counts as stopped.)
export function chatViewOpened(): () => void {
  openViews++;
  set({ unseen: false, chatShowing: true });
  return () => {
    openViews--;
    set({ chatShowing: openViews > 0 });
  };
}

// A reply (or a problem with it) is ready to read: dot on the tab if you're away.
function finished() {
  if (openViews === 0) set({ unseen: true });
}

export function setDraft(draft: string) {
  set({ draft });
}

// The message to offer Try again / Edit for, if the chat ends with one: a
// message whose reply you stopped, or a message that wasn't sent.
export function stoppedMessageOf(messages: ChatMessage[]): string | null {
  const last = messages.at(-1);
  if (last?.role === "user" && last.failed) return last.text;
  return last?.role === "assistant" && last.stopped && messages.at(-2)?.role === "user" ? messages.at(-2)!.text : null;
}

// The chat without that message (and its stopped reply), for Try again / Edit,
// so the message isn't shown twice.
function withoutRetried(messages: ChatMessage[]): ChatMessage[] {
  const last = messages.at(-1);
  if (stoppedMessageOf(messages) === null) return messages;
  return last?.role === "user" ? messages.slice(0, -1) : messages.slice(0, -2);
}

// Sends a message and follows Claude's reply until it's finished and its
// changes are saved, even if you switch tabs meanwhile.
// `replaceStopped`: the message replaces a stopped or unsent one (Try again /
// Edit), so that one is taken out of the chat first.
export async function sendChat(text: string, { replaceStopped = false } = {}) {
  const message = text.trim();
  const { messages, sending, undoing } = current();
  if (!message || sending || undoing) return;

  const base = replaceStopped ? withoutRetried(messages) : messages;
  const history: ChatMessage[] = [...base, { role: "user", text: message }];

  // Not sent: your message stays in the chat with a note saying why, plus
  // Try again / Edit. (Not back in the box: Send sits where Stop was, so a
  // second click would send it again.)
  const markFailed = (problem: Problem) =>
    set({ messages: [...base, { role: "user", text: message, failed: problem }], draft: "", error: null });

  // No internet: say so straight away, without trying.
  if (isOffline()) {
    markFailed({ message: OFFLINE_MESSAGE });
    return;
  }

  const abort = new AbortController();
  inProgress = abort;
  // False once the chat was cleared (or you signed out) during this reply.
  const stillCurrent = () => inProgress === abort;
  set({ messages: [...history, { role: "assistant", text: "" }], draft: "", error: null, sending: true });

  let reply = "";
  // Stopped: keep your message and what Claude wrote so far; nothing is saved.
  const markStopped = () =>
    set({ messages: [...history, { role: "assistant", text: splitReply(reply).text, stopped: true }] });
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abort.signal,
      // (Messages that weren't sent never reached Claude, so they're left out.)
      body: JSON.stringify({ messages: history.filter((m) => !m.failed).map(toTurn) }),
    });

    if (response.redirected || !response.ok || !response.body) {
      const problem = await problemFrom(response);
      if (stillCurrent()) markFailed(problem);
      return;
    }
    set({ leftToday: leftTodayFrom(response) });

    // Read the reply piece by piece and show each piece as it arrives.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reply += decoder.decode(value, { stream: true });
      set({ messages: [...history, { role: "assistant", text: splitReply(reply).text }] });
    }
    reply += decoder.decode();
    // Stop pressed just as the reply finished: still counts, so nothing is saved.
    if (abort.signal.aborted) {
      if (stillCurrent()) markStopped();
      return;
    }
    const { text: finalText, changes } = splitReply(reply);
    let answer: ChatMessage = { role: "assistant", text: finalText, ...(changes ? { changes } : {}) };
    // Claude's changes are saved straight away; from here on Stop is off.
    if (changes) {
      set({ savingNow: true, messages: [...history, { ...answer, saving: true }] });
      const { results, signedOut } = await saveChanges(changes);
      if (!stillCurrent()) return; // the chat was cleared meanwhile
      answer = { ...answer, results };
      if (signedOut) set({ error: { message: SIGNED_OUT_MESSAGE, code: "signed_out" } });
    }
    set({ messages: [...history, answer] });
  } catch {
    if (!stillCurrent()) return; // the chat was cleared
    if (abort.signal.aborted) {
      markStopped();
    } else if (reply) {
      set({
        messages: [...history, { role: "assistant", text: splitReply(reply).text, stopped: true }],
        error: { message: "The reply was cut off. Try asking again." },
      });
    } else {
      markFailed(connectionProblem());
    }
  } finally {
    if (stillCurrent()) {
      inProgress = null;
      set({ sending: false, savingNow: false });
      finished();
    }
  }
}

// Takes the message under the chat away (e.g. once you've signed in again).
export function clearChatError() {
  set({ error: null });
}

// Signed in again from any Sign in button (even on another tab): the chat's
// "You've been signed out" message is out of date.
// A message that wasn't sent because you were signed out keeps its note, but
// without the Sign in button.
// (current() reads the saved chat first if it hasn't been yet, e.g. right
// after the page was reloaded on the sign-in screen.)
onSignedIn(() => {
  const { error, messages } = current();
  const signedOut = (p?: Problem | null) => p?.code === "signed_out";
  if (!signedOut(error) && !messages.some((m) => signedOut(m.failed))) return;
  set({
    error: signedOut(error) ? null : error,
    messages: messages.map((m) => (signedOut(m.failed) ? { ...m, failed: { message: "You were signed out." } } : m)),
  });
});

// Stops the reply being written (only offered on the Chat screen).
export function stopChat() {
  inProgress?.abort();
}

// Undoes some of the changes saved with the reply at `at` (one Undo button,
// or all of them for Undo all). The newest change is undone first.
export async function undoChat(at: number, which: number[]) {
  const { messages, undoing, sending } = current();
  const results = messages[at]?.results;
  if (!results || undoing || sending) return;
  const picked = which.filter((i) => results[i]?.ok && !results[i].undone).reverse();
  if (picked.length === 0) return;

  set({ undoing: true });
  const failAll = (error: string) => picked.map((): UndoResult => ({ ok: false, error }));
  let outcome: UndoResult[];
  try {
    const undos = picked.map((i) => {
      const r = results[i];
      return r.ok ? r.undo : null;
    });
    const response = await undoChatChanges(undos);
    outcome = response.results ?? failAll(response.error ?? "Nothing was undone.");
    if (response.code === "signed_out") set({ error: { message: SIGNED_OUT_MESSAGE, code: "signed_out" } });
  } catch {
    outcome = failAll("Couldn't reach the app, so nothing was undone. Check your connection.");
  }
  set({ undoing: false });

  // Only if that reply is still there (the chat wasn't cleared meanwhile).
  const latest = current().messages;
  if (latest[at]?.results !== results) return;
  const updated = results.map((r, i): ShownResult => {
    const n = picked.indexOf(i);
    if (n === -1) return r;
    const o = outcome[n];
    return o.ok ? { ...r, undone: true, undoError: undefined } : { ...r, undoError: o.error };
  });
  set({ messages: latest.map((m, i) => (i === at ? { ...m, results: updated } : m)) });
}

// Empties the chat (the Clear chat button). Forgets the reply in progress
// first, so it can't put the old chat back.
export function clearChat() {
  const stopping = inProgress;
  inProgress = null;
  stopping?.abort();
  set({ messages: [], sending: false, savingNow: false, error: null });
  removeSaved();
}

// Forgets everything, including what's typed and the dot (called on sign-out:
// the next person on this device shouldn't see it).
export function clearSavedChat() {
  clearChat();
  set({ draft: "", unseen: false, undoing: false, leftToday: null });
}

// Splits what the server sent into Claude's text and the change details.
function splitReply(raw: string): { text: string; changes?: ChatChange[] } {
  const at = raw.indexOf(END_OF_TEXT);
  if (at === -1) return { text: raw };
  try {
    const { changes } = JSON.parse(raw.slice(at + 1)) as { changes: ChatChange[] };
    return { text: raw.slice(0, at), changes: Array.isArray(changes) && changes.length > 0 ? changes : undefined };
  } catch {
    return { text: raw.slice(0, at) }; // details not fully arrived yet
  }
}

// One message as sent to the server. For Claude's replies this includes what
// happened to their changes (saved, undone, failed) and whether you stopped
// it, so Claude knows instead of guessing.
function toTurn(m: ChatMessage) {
  if (m.role === "user") return { role: m.role, text: m.text };
  const changes = m.results
    ? m.results.map((r) =>
        r.ok
          ? { summary: r.summary, status: r.undone ? "undone" : "saved" }
          : { summary: r.summary, status: "failed", error: r.error },
      )
    : m.changes?.map((c) => ({ summary: c.summary, status: "unknown" }));
  return { role: m.role, text: m.text, ...(changes ? { changes } : {}), ...(m.stopped ? { stopped: true } : {}) };
}

// Saves Claude's changes and says how each one went. Never throws: a
// problem becomes a ✗ result for every change. Saving also tells every tab
// to reload its list (see chat-actions.ts), so they show the changes.
// signedOut: nothing was saved because the login had expired.
async function saveChanges(changes: ChatChange[]): Promise<{ results: ChangeResult[]; signedOut: boolean }> {
  const failAll = (error: string) => changes.map((c): ChangeResult => ({ ok: false, summary: c.summary, error }));
  try {
    const { error, code, results } = await applyChatChanges(changes);
    return { results: results ?? failAll(error ?? "Nothing was saved."), signedOut: code === "signed_out" };
  } catch {
    return { results: failAll("Couldn't reach the app, so nothing was saved. Check your connection."), signedOut: false };
  }
}

function readSaved(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function removeSaved() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (e.g. private browsing): nothing was saved anyway.
  }
}

function parseSaved(raw: string | null): ChatMessage[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (m): m is ChatMessage =>
          typeof m === "object" &&
          m !== null &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.text === "string",
      )
      .map((m) => ({
        ...m,
        saving: undefined, // a save cut short by closing the app isn't still running
        // The saved chat is only read on a signed-in screen (the app sends you
        // to sign in first otherwise), so "signed out" is old news: no Sign in button.
        ...(m.failed?.code === "signed_out" ? { failed: { message: "You were signed out." } } : {}),
      }));
  } catch {
    return [];
  }
}

function save(messages: ChatMessage[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // Storage full or blocked: the chat still works, it just won't survive a reload.
  }
}
