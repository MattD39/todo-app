"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Runs in the browser and draws nothing. Tells the server your time zone by
// saving it in a cookie. If it was missing or has changed (first visit, or
// you travelled), it reloads the data so "today" is worked out correctly.
// (Reloading when you come back to the app is RefreshOnReturn's job.)
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

  return null;
}
