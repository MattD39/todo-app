import type { TaskDTO } from "@/lib/tasks";
import { formatTime, isOverdue, relDay, dayOf, type Now } from "@/lib/dates";
import { OpenTaskButton } from "./task-editor";
import { CheckButton } from "./task-check";
import { SwipeRow } from "./swipe-row";

// The building blocks every list screen uses: a titled section (TaskGroup)
// containing rows (TaskRow). Same look as the old app.

const REPEAT_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" } as const;

export function TaskGroup({
  title,
  tasks,
  now,
  timeZone,
  warn = false,
  hideTodayDate = false,
  planned = false,
  swipe = false,
  isLocked,
}: {
  title: string;
  tasks: TaskDTO[];
  now: Now;
  timeZone: string;
  warn?: boolean; // red heading, for Overdue
  hideTodayDate?: boolean; // on Today, "Today" on every row would be noise
  planned?: boolean; // later repeats on the Calendar: view only, no tick box
  isLocked?: (task: TaskDTO) => boolean; // tick box shown but can't be tapped
  swipe?: boolean; // swipe a row left to delete it (Today, Upcoming, Done)
}) {
  if (tasks.length === 0) return null;
  return (
    <section className="mt-[18px]">
      <h2
        className={`mb-2 flex justify-between font-mono text-[0.74rem] font-medium tracking-[0.08em] uppercase ${
          warn ? "text-high" : "text-muted"
        }`}
      >
        <span>{title}</span>
        <span>{tasks.length}</span>
      </h2>
      <ul className="overflow-hidden rounded-[14px] border border-line bg-surface">
        {tasks.map((task) => (
          // A repeating task ticked twice today has two entries, so ticks use their own id.
          <TaskRow
            key={task.completionId ?? task.id}
            task={task}
            now={now}
            timeZone={timeZone}
            hideTodayDate={hideTodayDate}
            planned={planned}
            swipe={swipe && !planned}
            locked={isLocked?.(task) ?? false}
          />
        ))}
      </ul>
    </section>
  );
}

function TaskRow({
  task,
  now,
  timeZone,
  hideTodayDate,
  planned,
  swipe,
  locked,
}: {
  task: TaskDTO;
  now: Now;
  timeZone: string;
  hideTodayDate: boolean;
  planned: boolean;
  swipe: boolean;
  locked: boolean;
}) {
  const overdue = !planned && isOverdue(task, now);
  const due = planned ? null : dueLabel(task, now, overdue, hideTodayDate);

  const content = (
    <>
      {planned ? (
        // A later repeat can't be ticked (only the next one can), so a faint
        // ↻ sits where the tick box would be.
        <span aria-hidden className="mt-px grid size-[26px] flex-none place-items-center text-muted opacity-60">
          ↻
        </span>
      ) : (
        // In edit mode (Today, Upcoming, Done) the tick box folds away to no
        // width, so the title moves left into its place instead of being cut
        // off (the -mr-3 cancels the gap beside it). See SwipeRow.
        <span className="flex-none transition-[width,margin,opacity] duration-200 group-data-[editing=true]/row:-mr-3 group-data-[editing=true]/row:w-0 group-data-[editing=true]/row:overflow-hidden group-data-[editing=true]/row:opacity-0">
          <CheckButton task={task} today={now.today} locked={locked} />
        </span>
      )}
      {/* Tapping the title area opens the editor. */}
      <OpenTaskButton task={task} className={`min-w-0 flex-1 text-left ${planned ? "opacity-60" : ""}`}>
        <div className={`font-bold [overflow-wrap:anywhere] ${task.done ? "text-muted line-through" : ""}`}>
          {task.title}
        </div>
        <div className="mt-[3px] flex flex-wrap gap-x-2.5 gap-y-1 text-[0.82rem] text-muted empty:hidden">
          {task.priority === "high" && !task.done && <span className="font-bold text-high">High</span>}
          {task.category && <span>{task.category.name}</span>}
          {due && (
            <span className={`font-mono text-[0.76rem] ${overdue ? "font-medium text-high" : ""}`}>{due}</span>
          )}
          {task.repeat && <span>↻ {REPEAT_LABEL[task.repeat]}</span>}
          {/* Not on a repeating task's "Finished today" entry: its steps have
              already been reset for next time, so "0/3" would look wrong. */}
          {task.steps.length > 0 && !task.completionId && !planned && (
            <span>
              {task.steps.filter((s) => s.done).length}/{task.steps.length} steps
            </span>
          )}
          {planned && task.dueDate && (
            <span className="font-mono text-[0.76rem]">Next due: {relDay(task.dueDate, now.today)}</span>
          )}
          {task.completionId && task.dueDate && (
            <span className="font-mono text-[0.76rem]">Next: {relDay(task.dueDate, now.today)}</span>
          )}
          {task.done && task.doneAt && (
            <span className="font-mono text-[0.76rem]">Done {relDay(dayOf(task.doneAt, timeZone), now.today)}</span>
          )}
        </div>
      </OpenTaskButton>
    </>
  );

  if (swipe) {
    // A repeating task's past entry ("Finished today") deletes just that
    // entry; any other row deletes the whole task.
    const target = task.completionId ? { completionId: task.completionId } : { taskId: task.id };
    return (
      <SwipeRow target={target} label={task.title} className={`px-3.5 py-3 ${overdue ? "bg-over-soft" : ""}`}>
        {content}
      </SwipeRow>
    );
  }
  return (
    <li
      className={`flex items-start gap-3 border-t border-line px-3.5 py-3 first:border-t-0 ${
        overdue ? "bg-over-soft" : ""
      }`}
    >
      {content}
    </li>
  );
}

// e.g. "Tomorrow 5:30 PM", "Overdue · Yesterday", or just "5:30 PM" for
// something due later today on the Today screen.
function dueLabel(task: TaskDTO, now: Now, overdue: boolean, hideTodayDate: boolean): string | null {
  if (!task.dueDate || task.done) return null;
  const time = task.dueTime ? formatTime(task.dueTime) : "";
  if (hideTodayDate && task.dueDate === now.today && !overdue) return time || null;
  const label = [relDay(task.dueDate, now.today), time].filter(Boolean).join(" ");
  return overdue ? `Overdue · ${label}` : label;
}
