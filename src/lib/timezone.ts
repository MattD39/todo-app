import "server-only";
import { cookies } from "next/headers";
import { isValidTimeZone } from "./dates";

// The browser stores its time zone (e.g. "America/Toronto") in this cookie;
// see src/app/timezone-sync.tsx.
export const TIME_ZONE_COOKIE = "tz";

// The signed-in person's time zone, so "today" means *their* today rather
// than the server's (which runs on UTC). Falls back to UTC until the browser
// has reported it — that only happens on the very first visit.
export async function getTimeZone(): Promise<string> {
  const value = (await cookies()).get(TIME_ZONE_COOKIE)?.value;
  return value && isValidTimeZone(value) ? value : "UTC";
}
