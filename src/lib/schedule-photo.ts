import "server-only";
import { addDays, formatDay } from "./dates";

// Photo to schedule: a photo attached to a chat message (usually a work
// schedule), and the small helpers for turning its shifts into tasks.
//
// The photo is NEVER saved: not in the database, not in a file, not in a log.
// It goes to Claude with that one message and is then gone. Claude starts its
// reply with a plain-text list of what it read, and that list (part of the
// chat) is what later messages use.

// ─── The photo ───────────────────────────────────────────────────────────────

export type PhotoType = "image/jpeg" | "image/png" | "image/webp";
export type ChatPhoto = { mediaType: PhotoType; data: string }; // data: base64

// The phone shrinks a photo to about 300–700 KB before sending it; this leaves
// plenty of room while staying well under the hosting's 4.5 MB request limit.
export const MAX_PHOTO_BYTES = 3_000_000;

// The photo sent by the browser, checked: null if there's none, a message to
// show if it isn't a usable photo, otherwise the photo. Its type is worked out
// from the file's own first bytes, not from what the browser says it is.
export function cleanPhoto(input: unknown): ChatPhoto | null | string {
  if (input === undefined || input === null) return null;
  const notAPhoto = "That file isn't a photo the app can read. Try a JPEG or PNG photo.";
  const data = (input as { data?: unknown }).data;
  if (typeof data !== "string" || data.length < 16 || data.length % 4 !== 0) return notAPhoto;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return notAPhoto;
  const bytes = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (bytes > MAX_PHOTO_BYTES) return "That photo is too big. Try a smaller one.";
  const mediaType = photoTypeOf(Buffer.from(data.slice(0, 16), "base64"));
  if (!mediaType) return notAPhoto;
  return { mediaType, data };
}

function photoTypeOf(head: Buffer): PhotoType | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// What the newest message says when you send a photo with no words.
export const PHOTO_ONLY_MESSAGE = "(I sent a photo with no message.)";

// ─── Dates ───────────────────────────────────────────────────────────────────

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// "2026-11-23" → "Monday".
export function weekdayOf(day: string): Weekday {
  const sundayFirst = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(sundayFirst + 6) % 7];
}

// A ready-made calendar for Claude: four weeks from the Monday of this week,
// so it never has to work out which date "next Thursday" is by itself (small
// models can slip on that). Goes in the newest message.
export function describeCalendar(today: string): string {
  const monday = addDays(today, -WEEKDAYS.indexOf(weekdayOf(today)));
  const weeks: string[] = [];
  for (let w = 0; w < 4; w++) {
    const days = Array.from({ length: 7 }, (_, d) => {
      const day = addDays(monday, w * 7 + d);
      return `${formatDay(day)} = ${day}${day === today ? " (today)" : ""}`; // "Mon, Nov 23 = 2026-11-23"
    });
    const label = w === 0 ? "This week" : w === 1 ? "Next week" : `In ${w} weeks`;
    weeks.push(`${label}: ${days.join("; ")}`);
  }
  return `CALENDAR (use it for every date; weeks start on Monday):\n${weeks.join("\n")}`;
}

// ─── Names (5c-4) ────────────────────────────────────────────────────────────
//
// A name goes in a shift's title only if the user typed it in their own chat
// messages (capitals ignored), never because it's printed on the photo or
// Claude came up with it.

// Words that never count as a name, even though the user typed them.
const NOT_NAMES = new Set([
  ..."i me my mine myself you your yours we us our ours".split(" "),
  ..."he him his she her hers they them their theirs".split(" "),
  ..."shift shifts work works working add schedule the these those this that please".split(" "),
]);

// One word as a name key: small letters, without a possessive ("Elena's",
// "James'" → "elena", "james").
function nameKey(word: string): string {
  return word
    .toLowerCase()
    .replace(/[’']s$/, "")
    .replace(/[’']$/, "");
}

// The words the user typed, by key → the word as they wrote it (without a
// possessive). If they wrote a word several ways, a way with capitals wins
// (the latest one), so "Elena" beats "elena".
export function typedWords(userTexts: string[]): Map<string, string> {
  const words = new Map<string, string>();
  for (const text of userTexts) {
    for (const [raw] of text.matchAll(/[\p{L}\p{M}][\p{L}\p{M}’'-]*/gu)) {
      const key = nameKey(raw);
      if (!key || NOT_NAMES.has(key)) continue;
      const written = raw.replace(/[’']s$/, "").replace(/[’']$/, "");
      const before = words.get(key);
      if (!before || written !== written.toLowerCase() || before === before.toLowerCase()) words.set(key, written);
    }
  }
  return words;
}

// The name to put on a shift, from the one Claude sent: only the words the
// user typed, written the way they typed them, or with a capital first letter
// if they typed it all in small letters ("elena" → "Elena"). "" if Claude sent
// none. null if Claude sent a name but none of its words are the user's.
export function typedName(sent: string, typed: Map<string, string>): string | null {
  const words = sent.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return "";
  const kept = words
    .map((w) => typed.get(nameKey(w)))
    .filter((w): w is string => w !== undefined)
    .map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w));
  return kept.length > 0 ? kept.join(" ").slice(0, 40) : null;
}

// ─── Shift titles ────────────────────────────────────────────────────────────

// "Work 9 AM–5 PM", "Work 9:30 AM–5 PM", "Jess work 10 PM–6 AM (ends next day)".
// start/end are 24-hour "HH:MM". person: only when the user named whose shifts.
export function shiftTitle(start: string, end: string, person?: string | null): string {
  const who = person ? `${person} work` : "Work";
  const overnight = end <= start ? " (ends next day)" : "";
  return `${who} ${shortTime(start)}–${shortTime(end)}${overnight}`;
}

// A shift title taken apart: "Elena work 9 AM–5 PM" → person "elena", times
// "9 am–5 pm". Null if the title isn't shaped like a shift. (Accepts a plain
// "-" too, in case a task was typed by hand.)
function shiftParts(title: string): { person: string; name: string; times: string } | null {
  const time = String.raw`\d{1,2}(?::\d{2})?\s*[ap]m`;
  const match = new RegExp(String.raw`^(?:(.+?)\s+work|work)\s+(${time}\s*[–-]\s*${time}(?:\s*\(ends next day\))?)$`, "i").exec(
    title.replace(/\s+/g, " ").trim(),
  );
  if (!match) return null;
  return {
    person: (match[1] ?? "").toLowerCase(),
    name: match[1] ?? "", // as written, for rebuilding the title
    times: match[2].toLowerCase().replace(/\s+/g, "").replace("-", "–"),
  };
}

// Whether two shift titles on the same day are the same shift: same start and
// end time, and the same person: the same name (capitals ignored), or no name
// on either. A shift with no name is the user's own, so "Work 9 AM–5 PM" and
// "Elena work 9 AM–5 PM" are different people's shifts and both are allowed
// (the user's decision, 5c-4; the overlap rule counts people the same way).
export function sameShift(a: string, b: string): boolean {
  const x = shiftParts(a);
  const y = shiftParts(b);
  if (!x || !y || x.times !== y.times) return false;
  return x.person === y.person;
}

// When a shift title says it starts and ends, in minutes from midnight of its
// own day: "Work 11 AM–6 PM" → 660 to 1080. An overnight shift ends after
// 1440 ("Work 10 PM–6 AM (ends next day)" → 1320 to 1800). Null if the title
// isn't a shift.
export function shiftSpan(title: string): { start: number; end: number } | null {
  const parts = shiftParts(title);
  if (!parts) return null;
  const [start, end] = [...parts.times.matchAll(/(\d{1,2})(?::(\d{2}))?([ap])m/g)].map(
    (m) => ((Number(m[1]) % 12) + (m[3] === "p" ? 12 : 0)) * 60 + Number(m[2] ?? 0),
  );
  if (start === undefined || end === undefined) return null;
  return { start, end: end <= start ? end + 1440 : end };
}

// Whether two shift titles' times overlap (touching, like 6–10 then 10–2,
// doesn't count). Says nothing about the day or person: the caller checks those.
export function shiftsOverlap(a: string, b: string): boolean {
  const x = shiftSpan(a);
  const y = shiftSpan(b);
  return x !== null && y !== null && x.start < y.end && y.start < x.end;
}

// The name in front of a shift title, in small letters: "Elena work 9 AM–5 PM"
// → "elena", "Work 9 AM–5 PM" → "" (no name). Null if it isn't a shift title.
export function shiftPerson(title: string): string | null {
  return shiftParts(title)?.person ?? null;
}

// The name in front of a shift title as written ("Elena work 9 AM–5 PM" →
// "Elena"; "" for none), so a fixed shift keeps it. Null if not a shift title.
export function shiftName(title: string): string | null {
  return shiftParts(title)?.name ?? null;
}

function shortTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h >= 12 ? "PM" : "AM"}`;
}
