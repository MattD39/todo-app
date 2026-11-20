"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { saveTimeZone } from "./timezone-actions";

// Runs in the browser and draws nothing. Tells the server your time zone by
// saving it in a cookie. If it was missing or has changed (first visit, or
// you travelled), it reloads the data so "today" is worked out correctly.
// It also saves it on your account (savedTimeZone is what's there now), for
// Claude through the MCP server, which has no cookie.
// (Reloading when you come back to the app is RefreshOnReturn's job.)
export function TimeZoneSync({
  serverTimeZone,
  savedTimeZone,
}: {
  serverTimeZone: string;
  savedTimeZone: string | null;
}) {
  const router = useRouter();

  useEffect(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timeZone && timeZone !== savedTimeZone) void saveTimeZone(timeZone).catch(() => {});
  }, [savedTimeZone]);

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

  return null;
}
