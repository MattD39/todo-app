"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import {
  attachPhoto,
  chatViewOpened,
  clearChat,
  clearChatError,
  photoForRetry,
  sendChat,
  setDraft,
  stopChat,
  stoppedMessageOf,
  undoChat,
  useChat,
  type ChatMessage,
} from "./chat-store";
import { leftTodayNote } from "./api-problem";
import { ConfirmDialog } from "./confirm-dialog";
import { input } from "./form-styles";
import { ProblemNote } from "./problem-note";
import { shrinkPhoto, type ReadyPhoto } from "./shrink-photo";

// The Chat tab: talk to Claude about all your tasks.
//
// This screen only shows the chat and passes on your taps. The chat itself
// (sending, the reply, saving Claude's changes, Undo) runs in chat-store.ts,
// so a reply keeps going while you're on another tab.

const MAX_MESSAGE = 1000;

const STARTERS = [
  "What should I do first today?",
  "What's due this week?",
  "Is anything overdue?",
  "What did I finish this week?",
];

export function Chat() {
  const { messages, draft, sending, savingNow, undoing, error, leftToday, leftFor, attached } =
    useChat();
  // "3 chat messages left today." under the newest reply, when close to the
  // limit. After a photo message it's about photos, which have their own limit.
  const leftNote =
    !sending && messages.length > 0
      ? leftFor === "photo"
        ? leftTodayNote(leftToday, "photo message", "photo messages")
        : leftTodayNote(leftToday, "chat message", "chat messages")
      : "";
  // Try again / Edit after a stopped reply. Off for a moment right after Stop,
  // so fast clicking can't hit them by accident.
  const [retryReady, setRetryReady] = useState(true);
  const [editingStopped, setEditingStopped] = useState(false); // the box holds a stopped message being edited
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const composerRef = useRef<HTMLFormElement>(null);
  // Photo to schedule: the hidden file picker behind the 📷 button, whether a
  // picked photo is being shrunk, and a note about the photo (e.g. "too big").
  const fileRef = useRef<HTMLInputElement>(null);
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const [photoNote, setPhotoNote] = useState("");

  useKeepAboveKeyboard(composerRef);

  // While this screen is showing: no dot on the Chat tab. (Switching tabs
  // hides the screen, and a reply that finishes then puts the dot up.)
  useEffect(() => chatViewOpened(), []);

  // On a computer, opening Chat puts the cursor in the message box, ready to
  // type. Not on a phone or tablet with a touch screen: there it would pop the
  // keyboard up over the conversation. ("hover + fine pointer" = a mouse or
  // trackpad is the main way of pointing.)
  useEffect(() => {
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, []);

  // Follow the newest message: scroll to the bottom as the reply grows, but
  // only while you're at the bottom. Scroll up to read and it leaves you be;
  // scroll back down (or send a message) and it follows again.
  const followRef = useFollowBottom();
  const lastMessage = messages.at(-1);
  useEffect(() => {
    if (followRef.current) scrollToBottom();
  }, [followRef, messages.length, lastMessage, error]);

  // The message to offer Try again / Edit for: its reply was stopped, or it wasn't sent.
  const stoppedMessage = stoppedMessageOf(messages);

  function send(
    text: string,
    options?: { replaceStopped?: boolean; photo?: ReadyPhoto | null },
  ) {
    const photo = options?.photo === undefined ? attached : options.photo;
    if ((!text.trim() && !photo) || sending || undoing || preparingPhoto) return;
    setEditingStopped(false);
    setPhotoNote("");
    followRef.current = true; // you just sent something: show the reply
    void sendChat(text, options);
  }

  // A photo was picked: shrink it on this device, then show it above the box.
  async function photoPicked(file: File | undefined) {
    if (fileRef.current) fileRef.current.value = ""; // so picking the same photo again still works
    if (!file) return;
    setPhotoNote("");
    setPreparingPhoto(true);
    try {
      const result = await shrinkPhoto(file);
      if (typeof result === "string") {
        setPhotoNote(result);
      } else {
        attachPhoto(result);
        if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
          inputRef.current?.focus({ preventScroll: true });
        }
      }
    } finally {
      setPreparingPhoto(false);
    }
  }

  // Try again / Edit of a message that had a photo, after the photo is gone
  // from memory (a reload): the words go back in the box, and you pick the
  // photo again.
  const PICK_AGAIN =
    "The photo isn't kept after a reload. Pick it again with 📷, then Send.";

  function retry(message: ChatMessage) {
    if (!message.hadPhoto) {
      send(message.text, { replaceStopped: true, photo: null });
      return;
    }
    const photo = photoForRetry();
    if (photo) {
      send(message.text, { replaceStopped: true, photo });
    } else {
      edit(message);
    }
  }

  function edit(message: ChatMessage) {
    setDraft(message.text);
    setEditingStopped(true);
    if (message.hadPhoto) {
      const photo = photoForRetry();
      if (photo) attachPhoto(photo);
      else setPhotoNote(PICK_AGAIN);
    }
    inputRef.current?.focus();
  }

  function undo(at: number, which: number[]) {
    void undoChat(at, which);
  }

  function stop() {
    stopChat();
    setRetryReady(false);
    setTimeout(() => setRetryReady(true), 700);
  }

  function clear() {
    clearChat();
  }

  return (
    <>
      {messages.length === 0 ? (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-muted">
            Ask Claude about your tasks: what&apos;s due, what to do first, or
            how your week went. Claude can also add tasks, change them or tick
            them off for you. Tap the camera to send a photo of your work
            schedule, and Claude will add your shifts.
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
            const thinking =
              m.role === "assistant" &&
              !m.text &&
              sending &&
              i === messages.length - 1;
            return (
              <Fragment key={i}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 whitespace-pre-wrap ${
                    m.role === "user"
                      ? "self-end rounded-br-md bg-accent text-accent-ink"
                      : "self-start rounded-bl-md border border-line bg-surface text-ink"
                  }`}
                >
                  {m.hadPhoto && (
                    <span className="block text-[0.85rem] font-bold opacity-85">
                      📷 Photo
                    </span>
                  )}
                  {thinking ? (
                    <span className="text-muted">
                      {messages[i - 1]?.hadPhoto
                        ? "Claude is reading your photo…"
                        : "Claude is thinking…"}
                    </span>
                  ) : (
                    m.text
                  )}
                  {m.stopped && (
                    <span className="text-muted">
                      {m.text
                        ? " (stopped, nothing was changed)"
                        : "Stopped. Nothing was changed."}
                    </span>
                  )}
                  {m.changes && (
                    <ChangesNote
                      message={m}
                      busy={sending || undoing}
                      onUndo={(which) => undo(i, which)}
                    />
                  )}
                </div>
                {/* Your message wasn't sent: why (with Sign in when signed out). */}
                {m.failed && (
                  <div className="-mt-1 max-w-[85%] self-end text-right">
                    <ProblemNote problem={m.failed} prefix="Not sent." />
                  </div>
                )}
              </Fragment>
            );
          })}

          {/* Under the stopped reply or unsent message, well away from the Stop
              button (which sits in the bar at the bottom and covers the page
              there). The message only goes back in the box when you choose Edit. */}
          {stoppedMessage !== null && !sending && (
            <div
              className={`flex gap-2 ${messages.at(-1)?.role === "user" ? "self-end" : "self-start"}`}
            >
              <button
                type="button"
                disabled={!retryReady}
                onClick={() => retry(stoppedMessage)}
                className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-[0.9rem] font-bold text-ink disabled:opacity-50"
              >
                Try again
              </button>
              <button
                type="button"
                disabled={!retryReady}
                onClick={() => edit(stoppedMessage)}
                className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-[0.9rem] font-bold text-ink disabled:opacity-50"
              >
                Edit
              </button>
            </div>
          )}
        </div>
      )}

      {leftNote && <p className="mt-3 text-[0.85rem] text-muted">{leftNote}</p>}

      {error && (
        <div className="mt-3">
          <ProblemNote problem={error} onSignedIn={clearChatError} />
        </div>
      )}

      {/* Room for the photo strip above the message bar, so it never covers
          the newest message. */}
      {(attached || preparingPhoto || photoNote) && <div aria-hidden className="h-20" />}

      {/* Sits just above the tab bar (or above the keyboard while typing). */}
      <form
        ref={composerRef}
        onSubmit={(e) => {
          e.preventDefault();
          send(draft, { replaceStopped: editingStopped });
        }}
        className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] z-[6] border-t border-line bg-bg"
      >
        {/* The photo going with your next message (or a note about it). */}
        {(attached || preparingPhoto || photoNote) && (
          <div className="mx-auto flex max-w-[640px] items-center gap-3 px-4 pt-2.5">
            {attached && (
              <div className="relative flex-none">
                {/* A data: URL made on this device, so next/image has nothing to optimise. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={attached.dataUrl}
                  alt="Photo to send"
                  className="size-16 rounded-[10px] border border-line object-cover"
                />
                <button
                  type="button"
                  onClick={() => attachPhoto(null)}
                  aria-label="Remove photo"
                  title="Remove photo"
                  className="absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full border border-line bg-surface text-[0.9rem] font-bold text-ink shadow"
                >
                  ✕
                </button>
              </div>
            )}
            <p
              className={`text-[0.85rem] ${photoNote ? "font-bold text-high" : "text-muted"}`}
            >
              {preparingPhoto
                ? "Getting the photo ready…"
                : photoNote ||
                  "Claude will read the schedule and add your shifts. Add a note if you like."}
            </p>
          </div>
        )}
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
          {/* Photo to schedule. On iPhone this offers Take Photo, Photo
              Library or Choose File. */}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={sending || preparingPhoto}
            aria-label="Add a photo of a schedule"
            title="Add a photo of a schedule"
            className="flex w-11 flex-none items-center justify-center rounded-[10px] border border-line bg-surface text-muted disabled:opacity-50"
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
              <path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => void photoPicked(e.target.files?.[0])}
          />
          <label htmlFor="chat-message" className="sr-only">
            Message Claude
          </label>
          <input
            id="chat-message"
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_MESSAGE}
            placeholder={attached ? "Add a note (optional)…" : "Ask about your tasks…"}
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
              disabled={(!draft.trim() && !attached) || preparingPhoto}
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

// Claude's changes under its reply. Only a ✓ line means a change was saved;
// Claude's own words never claim that. Each saved change has its own Undo,
// plus Undo all when one message made more than one change.
function ChangesNote({
  message,
  busy,
  onUndo,
}: {
  message: ChatMessage;
  busy: boolean; // a reply or another Undo is in progress
  onUndo: (which: number[]) => void;
}) {
  const { changes = [], results, saving } = message;
  // Changes that were saved and haven't been undone yet.
  const undoable = (results ?? []).flatMap((r, i) =>
    r.ok && !r.undone ? [i] : [],
  );
  const smallButton =
    "flex-none rounded-full border border-line bg-bg px-3 py-1 text-[0.85rem] font-bold text-ink disabled:opacity-50";
  return (
    <div className="mt-2 border-t border-line pt-2 text-[0.92rem] whitespace-normal">
      {saving ? (
        <p className="text-muted">Saving…</p>
      ) : results ? (
        <>
          <ul className="flex flex-col gap-1.5">
            {results.map((r, i) => (
              <li key={i}>
                {r.ok ? (
                  <div className="flex items-center justify-between gap-2">
                    {r.undone ? (
                      <span className="text-muted">↩ Undone: {r.summary}</span>
                    ) : (
                      <>
                        <span>✓ {r.summary}</span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onUndo([i])}
                          className={smallButton}
                        >
                          Undo
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <span className="font-bold text-high">
                    ✗ Not saved: {r.summary}. {r.error}
                  </span>
                )}
                {r.undoError && (
                  <p className="text-[0.85rem] font-bold text-high">
                    Couldn&apos;t undo: {r.undoError}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {undoable.length >= 2 && (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={() => onUndo(undoable)}
                className={smallButton}
              >
                Undo all
              </button>
            </div>
          )}
        </>
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

// The very bottom of the page. The page has room at the bottom for the
// message bar and tab bar, so the newest message ends up just above them
// (not hidden behind them).
function scrollToBottom() {
  window.scrollTo({ top: document.documentElement.scrollHeight });
}

// Whether the chat should follow new text. Becomes false when you scroll up,
// true again when you're back near the bottom. (A reply growing doesn't move
// the page, so only real scrolling changes it.)
function useFollowBottom() {
  const follow = useRef(true);
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const nearBottom =
        window.innerHeight + y >= document.documentElement.scrollHeight - 80;
      if (nearBottom) follow.current = true;
      else if (y < lastY) follow.current = false; // you scrolled up
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return follow;
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
      el.style.bottom =
        covered > 100 && Math.abs(view.scale - 1) < 0.01 ? `${covered}px` : "";
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
