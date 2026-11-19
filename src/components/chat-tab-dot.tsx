"use client";

import { useChat } from "./chat-store";

// A small dot on the Chat tab's icon when Claude finished a reply while you
// were on another tab. Opening Chat clears it (see chatViewOpened).
export function ChatTabDot() {
  const { unseen } = useChat();
  if (!unseen) return null;
  return (
    <>
      <span aria-hidden className="absolute -top-0.5 -right-1 size-2.5 rounded-full bg-accent ring-2 ring-surface" />
      <span className="sr-only">(new reply)</span>
    </>
  );
}
