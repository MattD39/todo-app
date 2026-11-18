"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { applyChatChanges } from "@/app/chat-actions";
import type { ChangeResult, ChatChange } from "@/lib/chat-changes";
import { problemMessage } from "./api-problem";
import { ConfirmDialog } from "./confirm-dialog";
import { input } from "./form-styles";

// The Chat tab: talk to Claude about all your tasks.
//
// Each message is sent to /api/chat with the conversation so far; the server
// adds your current task list itself and streams Claude's reply back, word by
// word. If Claude changed tasks (or wants to), the details come at the
// very end of the stream, after END_OF_TEXT.
//
// The conversation is kept in sessionStorage: it survives switching tabs, and
// is gone when the app is closed or you sign out. It's never saved on the server.

const STORAGE_KEY = "chat";
const MAX_MESSAGE = 1000;

const STARTERS = [
  "What should I do first today?",
  "What's due this week?",
  "Is anything overdue?",
  "What did I finish this week?",
];

// Marks where Claude's text ends and the change details begin (same as the server's).
const END_OF_TEXT = "";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  stopped?: boolean;
  changes?: ChatChange[]; // changes Claude queued with this reply (not saved by Claude)
  saving?: boolean;
  results?: ChangeResult[]; // how saving them went: the only thing that says ✓ done
};

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

// Forgets the conversation (called on sign-out too).
export function clearSavedChat() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (e.g. private browsing): nothing was saved anyway.
  }
}

function readSaved(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
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
    // Storage full or blocked: the chat still works, it just won't survive a tab switch.
  }
}

const noSubscribe = () => () => {};

export function Chat() {
  // The saved conversation, read once the page is running in the browser
  // (the server has no sessionStorage, so it draws an empty chat first).
  const saved = useSyncExternalStore(noSubscribe, readSaved, () => null);
  const [changed, setChanged] = useState<ChatMessage[] | null>(null);
  const messages = changed ?? parseSaved(saved);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [savingNow, setSavingNow] = useState(false); // Claude's changes are being saved: too late to stop
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useKeepAboveKeyboard(composerRef);

  // Leaving the Chat tab mid-reply stops Claude (what it wrote so far is kept).
  useEffect(() => () => abortRef.current?.abort(), []);

  // Keep the newest message in view as the reply grows.
  const lastText = messages.at(-1)?.text;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, lastText, error]);

  function update(next: ChatMessage[]) {
    setChanged(next);
    save(next);
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;

    const history: ChatMessage[] = [...messages, { role: "user", text: message }];
    update([...history, { role: "assistant", text: "" }]);
    setDraft("");
    setError(null);
    setSending(true);

    // On a problem before Claude wrote anything, take the message back out and
    // put it back in the box, so pressing Send again retries it. (Not after
    // Stop: Send sits where Stop was, so a second click would send it again.)
    const giveBack = (problem: string) => {
      update(messages);
      setDraft(message);
      setError(problem);
    };

    const abort = new AbortController();
    abortRef.current = abort;
    let reply = "";
    // Stopped: keep your message and what Claude wrote so far; nothing is saved.
    const markStopped = () => update([...history, { role: "assistant", text: splitReply(reply).text, stopped: true }]);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({ messages: history.map(({ role, text }) => ({ role, text })) }),
      });

      if (response.redirected || !response.ok || !response.body) {
        giveBack(await problemMessage(response));
        return;
      }

      // Read the reply piece by piece and show each piece as it arrives.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        reply += decoder.decode(value, { stream: true });
        update([...history, { role: "assistant", text: splitReply(reply).text }]);
      }
      reply += decoder.decode();
      // Stop pressed just as the reply finished: still counts, so nothing is saved.
      if (abort.signal.aborted) {
        if (abortRef.current === abort) markStopped();
        return;
      }
      const { text: finalText, changes } = splitReply(reply);
      let answer: ChatMessage = { role: "assistant", text: finalText, ...(changes ? { changes } : {}) };
      // Claude's changes are saved straight away; from here on Stop is off.
      if (changes) {
        setSavingNow(true);
        update([...history, { ...answer, saving: true }]);
        const results = await saveChanges(changes);
        if (abortRef.current !== abort) return; // the chat was cleared meanwhile
        answer = { ...answer, results };
      }
      update([...history, answer]);
    } catch {
      if (abort.signal.aborted) {
        if (abortRef.current !== abort) return; // the chat was cleared
        markStopped();
        return;
      }
      if (reply) {
        update([...history, { role: "assistant", text: splitReply(reply).text, stopped: true }]);
        setError("The reply was cut off. Try asking again.");
      } else {
        giveBack("Couldn't reach Claude. Check your connection and try again.");
      }
    } finally {
      if (abortRef.current === abort) {
        abortRef.current = null;
        setSending(false);
        setSavingNow(false);
      }
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function clear() {
    // Forget the reply in progress first, so it can't put the old chat back.
    const inProgress = abortRef.current;
    abortRef.current = null;
    inProgress?.abort();
    setSending(false);
    setSavingNow(false);
    update([]);
    clearSavedChat();
    setError(null);
  }

  return (
    <>
      {messages.length === 0 ? (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-muted">
            Ask Claude about your tasks: what&apos;s due, what to do first, or how your week went. Claude can also add
            tasks, change them or tick them off for you.
          </p>
          <div className="flex flex-wrap gap-2">
            {STARTERS.map((starter) => (
              <button
                key={starter}
                type="button"
                onClick={() => send(starter)}
                className="rounded-full border border-line bg-surface px-3.5 py-2 text-[0.92rem] text-ink"
              >
                {starter}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-2.5" aria-live="polite">
          {messages.map((m, i) => {
            const thinking = m.role === "assistant" && !m.text && sending && i === messages.length - 1;
            return (
              <div
                key={i}
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 whitespace-pre-wrap ${
                  m.role === "user"
                    ? "self-end rounded-br-md bg-accent text-accent-ink"
                    : "self-start rounded-bl-md border border-line bg-surface text-ink"
                }`}
              >
                {thinking ? <span className="text-muted">Claude is thinking…</span> : m.text}
                {m.stopped && (
                  <span className="text-muted">{m.text ? " (stopped, nothing was changed)" : "Stopped. Nothing was changed."}</span>
                )}
                {m.changes && <ChangesNote message={m} />}
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[0.9rem] font-bold text-high">
          {error}
        </p>
      )}
      <div ref={endRef} className="h-px" />

      {/* Sits just above the tab bar (or above the keyboard while typing). */}
      <form
        ref={composerRef}
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] z-[6] border-t border-line bg-bg"
      >
        <div className="mx-auto flex max-w-[640px] gap-2 px-4 py-2.5">
          {/* Always on screen, so a long chat needs no scrolling to clear. It sits
              near Send, so it asks first. */}
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmingClear(true)}
              aria-label="Clear chat"
              title="Clear chat"
              className="flex w-11 flex-none items-center justify-center rounded-[10px] border border-line bg-surface text-muted"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="size-5"
              >
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
              </svg>
            </button>
          )}
          <label htmlFor="chat-message" className="sr-only">
            Message Claude
          </label>
          <input
            id="chat-message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_MESSAGE}
            placeholder="Ask about your tasks…"
            autoComplete="off"
            enterKeyHint="send"
            className={input}
          />
          {/* Two separate buttons (the keys stop React reusing one for the
              other), so a click that starts on Stop can never end up as Send. */}
          {sending ? (
            <button
              key="stop"
              type="button"
              onClick={stop}
              disabled={savingNow}
              className="flex-none rounded-[10px] border border-line bg-surface px-4 font-bold text-high disabled:opacity-50"
            >
              {savingNow ? "Saving…" : "Stop"}
            </button>
          ) : (
            <button
              key="send"
              type="submit"
              disabled={!draft.trim()}
              className="flex-none rounded-[10px] bg-accent px-4 font-bold text-accent-ink disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </form>

      {/* Kept outside the <form> so its buttons can't send a message. */}
      {confirmingClear && (
        <ConfirmDialog
          title="Clear this chat?"
          confirmLabel="Clear chat"
          onCancel={() => setConfirmingClear(false)}
          onConfirm={() => {
            setConfirmingClear(false);
            clear();
          }}
        >
          The whole conversation will be removed. Your tasks won&apos;t change.
        </ConfirmDialog>
      )}
    </>
  );
}

// Saves Claude's changes and says how each one went. Never throws: a
// problem becomes a ✗ result for every change.
async function saveChanges(changes: ChatChange[]): Promise<ChangeResult[]> {
  const failAll = (error: string) => changes.map((c): ChangeResult => ({ ok: false, summary: c.summary, error }));
  try {
    const { error, results } = await applyChatChanges(changes);
    return results ?? failAll(error ?? "Nothing was saved.");
  } catch {
    return failAll("Couldn't reach the app, so nothing was saved. Check your connection.");
  }
}

// Claude's changes under its reply. Only a ✓ line means a change was saved;
// Claude's own words never claim that. (Plain for now: Undo buttons come next.)
function ChangesNote({ message }: { message: ChatMessage }) {
  const { changes = [], results, saving } = message;
  return (
    <div className="mt-2 border-t border-line pt-2 text-[0.92rem]">
      {saving ? (
        <p className="text-muted">Saving…</p>
      ) : results ? (
        results.map((r, i) =>
          r.ok ? (
            <p key={i}>✓ {r.summary}</p>
          ) : (
            <p key={i} className="font-bold text-high">
              ✗ Not saved: {r.summary}. {r.error}
            </p>
          ),
        )
      ) : (
        // Saving never finished (e.g. the app was closed meanwhile): it may or may not have worked.
        changes.map((c, i) => (
          <p key={i} className="text-muted">
            ? {c.summary} (not sure it was saved: check your list)
          </p>
        ))
      )}
    </div>
  );
}

// On iPhone the keyboard slides over the bottom of the page without making it
// smaller, which would hide the message box. While the keyboard is up, this
// moves the box to sit right on top of it; when it goes away, the box goes
// back above the tab bar.
function useKeepAboveKeyboard(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const view = window.visualViewport;
    const el = ref.current;
    if (!view || !el) return;

    const place = () => {
      const covered = window.innerHeight - view.height - view.offsetTop;
      // Over 100px hidden means a keyboard (not just a toolbar); ignore pinch-zoom.
      el.style.bottom = covered > 100 && Math.abs(view.scale - 1) < 0.01 ? `${covered}px` : "";
    };

    place();
    view.addEventListener("resize", place);
    view.addEventListener("scroll", place);
    return () => {
      view.removeEventListener("resize", place);
      view.removeEventListener("scroll", place);
      el.style.bottom = "";
    };
  }, [ref]);
}
