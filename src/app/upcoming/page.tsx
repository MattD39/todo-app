import { Suspense } from "react";
import { relDay } from "@/lib/dates";
import { buildUpcoming, inCategory } from "@/lib/views";
import { TaskGroup } from "@/components/task-list";
import { loadScreen, Screen, ScreenLoading, Status, type SearchParams } from "@/components/screen";

// The Upcoming screen: everything due after today, grouped by day.
export default function UpcomingPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="mx-auto max-w-[640px] px-4 pb-40">
      <Suspense fallback={<ScreenLoading tab="upcoming" />}>
        <Upcoming searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Upcoming({ searchParams }: { searchParams: SearchParams }) {
  const data = await loadScreen(searchParams);
  const days = buildUpcoming(inCategory(data.open, data.category), data.now);

  return (
    <Screen tab="upcoming" data={data}>
      {days.length === 0 && (
        <Status>No tasks scheduled after today. Add one with a due date to see it here.</Status>
      )}
      {days.map(({ day, tasks }) => (
        <TaskGroup key={day} title={relDay(day, data.now.today)} tasks={tasks} now={data.now} timeZone={data.timeZone} />
      ))}
    </Screen>
  );
}
