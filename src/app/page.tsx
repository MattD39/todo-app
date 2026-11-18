import { Suspense } from "react";
import { listRecentlyDoneTasks } from "@/lib/tasks";
import { buildToday, inCategory } from "@/lib/views";
import { TaskGroup } from "@/components/task-list";
import { loadScreen, Screen, ScreenLoading, Status, type SearchParams } from "@/components/screen";

// The Today screen: Overdue / Due today / Anytime / Finished today.
export default function TodayPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="mx-auto max-w-[640px] px-4 pb-40">
      {/* Depends on who's signed in and their time zone, so it loads fresh on
          each visit behind a Suspense boundary. */}
      <Suspense fallback={<ScreenLoading tab="today" />}>
        <Today searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Today({ searchParams }: { searchParams: SearchParams }) {
  const [data, recentlyDone] = await Promise.all([loadScreen(searchParams), listRecentlyDoneTasks()]);
  const { now, timeZone, category } = data;
  const view = buildToday(inCategory(data.open, category), inCategory(recentlyDone, category), now, timeZone);
  const nothingDue = !view.overdue.length && !view.dueToday.length && !view.anytime.length;
  const shared = { now, timeZone, swipe: true };

  return (
    <Screen tab="today" data={data}>
      {data.open.length === 0 && recentlyDone.length === 0 ? (
        <Status>
          Your list is empty. Tap <b>Add task</b> to add your first one.
        </Status>
      ) : (
        nothingDue && (
          <Status>
            Nothing due today. Tap <b>Add task</b> to plan something, or check <b>Upcoming</b>.
          </Status>
        )
      )}

      <TaskGroup title="Overdue" tasks={view.overdue} warn {...shared} />
      <TaskGroup title="Due today" tasks={view.dueToday} hideTodayDate {...shared} />
      <TaskGroup title="Anytime" tasks={view.anytime} {...shared} />
      <TaskGroup title="Finished today" tasks={view.finishedToday} hideTodayDate {...shared} />
    </Screen>
  );
}
