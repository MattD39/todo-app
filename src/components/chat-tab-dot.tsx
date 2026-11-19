"use client";

import { useChat } from "./chat-store";

// What the Chat tab's icon shows while you're on another tab:
// - an animated "…" while Claude is still replying,
// - a small dot once a reply finished (opening Chat clears it).
// On the Chat tab itself, neither.
export function ChatTabDot() {
  const { sending, unseen, chatShowing } = useChat();
  if (chatShowing) return null;

  if (sending) {
    return (
      <>
        <span
          aria-hidden
          className="absolute -top-1.5 -right-3 flex items-center gap-[2px] rounded-full bg-accent px-[4px] py-[3px] ring-2 ring-surface"
        >
          <span className="typing-dot size-[3px] rounded-full bg-accent-ink" />
          <span className="typing-dot size-[3px] rounded-full bg-accent-ink" />
          <span className="typing-dot size-[3px] rounded-full bg-accent-ink" />
        </span>
        <span className="sr-only">(Claude is replying)</span>
      </>
    );
  }

  if (!unseen) return null;
  return (
    <>
      <span aria-hidden className="absolute -top-0.5 -right-1 size-2.5 rounded-full bg-accent ring-2 ring-surface" />
      <span className="sr-only">(new reply)</span>
    </>
  );
}
