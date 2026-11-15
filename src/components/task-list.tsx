import type { TaskDTO } from "@/lib/tasks";
import { formatTime, isOverdue, relDay, dayOf, type Now } from "@/lib/dates";
import { OpenTaskButton } from "./task-editor";
import { CheckButton } from "./task-check";

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
}: {
  title: string;
  tasks: TaskDTO[];
  now: Now;
  timeZone: string;
  warn?: boolean; // red heading, for Overdue
  hideTodayDate?: boolean; // on Today, "Today" on every row would be noise
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
          <TaskRow key={task.id} task={task} now={now} timeZone={timeZone} hideTodayDate={hideTodayDate} />
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
}: {
  task: TaskDTO;
  now: Now;
  timeZone: string;
  hideTodayDate: boolean;
}) {
  const overdue = isOverdue(task, now);
  const due = dueLabel(task, now, overdue, hideTodayDate);

  return (
    <li
      className={`flex items-start gap-3 border-t border-line px-3.5 py-3 first:border-t-0 ${
        overdue ? "bg-over-soft" : ""
      }`}
    >
      <CheckButton task={task} />
      {/* Tapping the title area opens the editor. */}
      <OpenTaskButton task={task} className="min-w-0 flex-1 text-left">
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
          {task.done && task.doneAt && (
            <span className="font-mono text-[0.76rem]">Done {relDay(dayOf(task.doneAt, timeZone), now.today)}</span>
          )}
        </div>
      </OpenTaskButton>
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
