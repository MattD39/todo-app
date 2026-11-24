import { Suspense } from "react";
import { listDoneTasks } from "@/lib/tasks";
import { inCategory } from "@/lib/views";
import { TaskGroup } from "@/components/task-list";
import { loadScreen, Screen, ScreenLoading, Status, type SearchParams } from "@/components/screen";

// The Done screen: finished tasks and each tick of a repeating task ("brush
// teeth" ticked today shows here as its own entry), most recent first.
export default function DonePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="mx-auto max-w-[640px] px-4 pb-40">
      <Suspense fallback={<ScreenLoading tab="done" />}>
        <Done searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

const SHOW_LAST = 100;

async function Done({ searchParams }: { searchParams: SearchParams }) {
  const [data, done] = await Promise.all([loadScreen(searchParams), listDoneTasks(SHOW_LAST)]);
  const tasks = inCategory(done, data.category);

  return (
    <Screen tab="done" data={data}>
      {tasks.length === 0 ? (
        <Status>Finished tasks show up here.</Status>
      ) : (
        <TaskGroup
          title={done.length === SHOW_LAST ? `Last ${SHOW_LAST} completed` : "Completed"}
          tasks={tasks}
          now={data.now}
          timeZone={data.timeZone}
          swipe
          // A repeating task's older entries show ticked but can't be un-ticked:
          // only its most recent tick can be undone (same as the Calendar).
          isLocked={(t) => "isLatest" in t && !t.isLatest}
        />
      )}
    </Screen>
  );
}
