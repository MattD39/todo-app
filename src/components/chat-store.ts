"use client";

import { useSyncExternalStore } from "react";
import { applyChatChanges, undoChatChanges } from "@/app/chat-actions";
import type { ChangeResult, ChatChange, UndoResult } from "@/lib/chat-changes";
import { problemMessage } from "./api-problem";

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
};

// A saved change as shown in the chat, plus what happened when you pressed Undo.
export type ShownResult = ChangeResult & { undone?: boolean; undoError?: string };

export type ChatState = {
  messages: ChatMessage[];
  draft: string; // what's typed in the message box
  sending: boolean; // a reply is on its way (Stop is showing)
  savingNow: boolean; // Claude's changes are being saved: too late to stop
  undoing: boolean; // an Undo is being saved
  error: string | null;
  unseen: boolean; // a reply finished while the Chat tab wasn't showing (the dot)
};

const EMPTY: ChatState = {
  messages: [],
  draft: "",
  sending: false,
  savingNow: false,
  undoing: false,
  error: null,
  unseen: false,
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
// it's showing a finished reply doesn't add one. Returns the "stopped
// showing" function. (Switching tabs hides the screen, which counts as stopped.)
export function chatViewOpened(): () => void {
  openViews++;
  if (current().unseen) set({ unseen: false });
  return () => {
    openViews--;
  };
}

// A reply (or a problem with it) is ready to read: dot on the tab if you're away.
function finished() {
  if (openViews === 0) set({ unseen: true });
}

export function setDraft(draft: string) {
  set({ draft });
}

// The message you stopped, if the chat ends with a stopped reply (for Try again / Edit).
export function stoppedMessageOf(messages: ChatMessage[]): string | null {
  const last = messages.at(-1);
  return last?.role === "assistant" && last.stopped && messages.at(-2)?.role === "user" ? messages.at(-2)!.text : null;
}

// Sends a message and follows Claude's reply until it's finished and its
// changes are saved, even if you switch tabs meanwhile.
// `replaceStopped`: the message replaces a stopped one (Try again / Edit),
// so that stopped exchange is taken out of the chat first.
export async function sendChat(text: string, { replaceStopped = false } = {}) {
  const message = text.trim();
  const { messages, sending, undoing } = current();
  if (!message || sending || undoing) return;

  const stopped = stoppedMessageOf(messages);
  const base = replaceStopped && stopped !== null ? messages.slice(0, -2) : messages;
  const history: ChatMessage[] = [...base, { role: "user", text: message }];
  const abort = new AbortController();
  inProgress = abort;
  // False once the chat was cleared (or you signed out) during this reply.
  const stillCurrent = () => inProgress === abort;
  set({ messages: [...history, { role: "assistant", text: "" }], draft: "", error: null, sending: true });

  // On a problem before Claude wrote anything, take the message back out and
  // put it back in the box, so pressing Send again retries it. (Not after
  // Stop: Send sits where Stop was, so a second click would send it again.)
  const giveBack = (problem: string) => set({ messages: base, draft: message, error: problem });

  let reply = "";
  // Stopped: keep your message and what Claude wrote so far; nothing is saved.
  const markStopped = () =>
    set({ messages: [...history, { role: "assistant", text: splitReply(reply).text, stopped: true }] });
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abort.signal,
      body: JSON.stringify({ messages: history.map(toTurn) }),
    });

    if (response.redirected || !response.ok || !response.body) {
      const problem = await problemMessage(response);
      if (stillCurrent()) giveBack(problem);
      return;
    }

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
      const results = await saveChanges(changes);
      if (!stillCurrent()) return; // the chat was cleared meanwhile
      answer = { ...answer, results };
    }
    set({ messages: [...history, answer] });
  } catch {
    if (!stillCurrent()) return; // the chat was cleared
    if (abort.signal.aborted) {
      markStopped();
    } else if (reply) {
      set({
        messages: [...history, { role: "assistant", text: splitReply(reply).text, stopped: true }],
        error: "The reply was cut off. Try asking again.",
      });
    } else {
      giveBack("Couldn't reach Claude. Check your connection and try again.");
    }
  } finally {
    if (stillCurrent()) {
      inProgress = null;
      set({ sending: false, savingNow: false });
      finished();
    }
  }
}

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
  set({ draft: "", unseen: false, undoing: false });
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
async function saveChanges(changes: ChatChange[]): Promise<ChangeResult[]> {
  const failAll = (error: string) => changes.map((c): ChangeResult => ({ ok: false, summary: c.summary, error }));
  try {
    const { error, results } = await applyChatChanges(changes);
    return results ?? failAll(error ?? "Nothing was saved.");
  } catch {
    return failAll("Couldn't reach the app, so nothing was saved. Check your connection.");
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
      .map((m) => ({ ...m, saving: undefined })); // a save cut short by closing the app isn't still running
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
