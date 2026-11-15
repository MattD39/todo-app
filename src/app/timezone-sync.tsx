"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Runs in the browser. It does two small jobs and draws nothing:
//
// 1. Tells the server your time zone by saving it in a cookie. If it was
//    missing or has changed (first visit, or you travelled), it reloads the
//    data so "today" is worked out correctly.
// 2. When you come back to the app (e.g. reopen it on your phone the next
//    morning), it reloads the data so the lists aren't stale.
export function TimeZoneSync({ serverTimeZone }: { serverTimeZone: string }) {
  const router = useRouter();

  useEffect(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Time zone names only use letters, digits, "/", "_", "+" and "-", which are
    // all safe in a cookie as-is.
    if (timeZone && /^[A-Za-z0-9/_+-]+$/.test(timeZone) && timeZone !== serverTimeZone) {
      const secure = location.protocol === "https:" ? "; secure" : "";
      document.cookie = `tz=${timeZone}; path=/; max-age=31536000; samesite=lax${secure}`;
      router.refresh();
    }
  }, [serverTimeZone, router]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [router]);

  return null;
}
