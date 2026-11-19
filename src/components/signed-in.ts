"use client";

import { useSyncExternalStore } from "react";

// "You signed in again", announced to the whole app, so one sign-in (from any
// Sign in button) clears every "You've been signed out" message at once:
// Suggest steps, Ask Claude and Chat.

let signIns = 0; // how many times you've signed in again since the app opened
const listeners = new Set<() => void>();

export function announceSignedIn() {
  signIns++;
  for (const listener of listeners) listener();
}

// Runs `listener` after each sign-in. Returns the "stop listening" function.
export function onSignedIn(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The number of sign-ins so far; redraws the component when it goes up.
export function useSignInCount(): number {
  return useSyncExternalStore(
    onSignedIn,
    () => signIns,
    () => 0,
  );
}
