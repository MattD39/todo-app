import { Suspense } from "react";
import { isValidDay, monthGrid } from "@/lib/dates";
import { listHistory } from "@/lib/tasks";
import { calendarMarks, futureRepeats, inCategories } from "@/lib/views";
import { MonthCalendar } from "@/components/calendar";
import { loadScreen, Screen, ScreenLoading, type SearchParams } from "@/components/screen";

// The Calendar screen: a month grid, and the selected day's tasks under it.
export default function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="mx-auto max-w-[640px] px-4 pb-40">
      <Suspense fallback={<ScreenLoading tab="calendar" />}>
        <Calendar searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Calendar({ searchParams }: { searchParams: SearchParams }) {
  const [data, params] = await Promise.all([loadScreen(searchParams), searchParams]);
  // ?day=2026-11-21 picks the day (and so the month); anything else means today.
  const day = typeof params.day === "string" && isValidDay(params.day) ? params.day : data.now.today;
  const open = inCategories(data.open, data.picked);
  // Later repeats for every day on screen, including the greyed-out ones.
  const grid = monthGrid(day);
  const repeats = futureRepeats(open, grid[0], grid.at(-1)!, data.now.today);
  const history = await listHistory(grid[0], grid.at(-1)!);
  const inCat = { done: inCategories(history.done, data.picked), ticks: inCategories(history.ticks, data.picked) };

  return (
    <Screen tab="calendar" data={data}>
      {/* Starts fresh whenever the server sends a different day. */}
      <MonthCalendar
        key={day}
        initialDay={day}
        open={open}
        marks={calendarMarks(open, repeats, data.now)}
        repeats={repeats}
        history={inCat}
        now={data.now}
        timeZone={data.timeZone}
        picked={data.picked}
      />
    </Screen>
  );
}
