"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// How long you need to be away before coming back reloads the data.
const AWAY_MS = 60_000;

// A home-screen app has no reload button, and iPhone keeps it paused in the
// background, so opening it the next morning could still show yesterday's
// "Today". This quietly fetches fresh data when you come back to the app
// after a minute or more, or when your connection returns.
// router.refresh() reloads what's on screen from the server without losing
// anything on the page, like an open sheet or what you've typed.
export function RefreshOnReturn() {
  const router = useRouter();

  useEffect(() => {
    let hiddenAt: number | null = null;

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else if (hiddenAt !== null && Date.now() - hiddenAt >= AWAY_MS) {
        hiddenAt = null;
        router.refresh();
      }
    }
    function onOnline() {
      router.refresh();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onOnline);
    };
  }, [router]);

  return null;
}
