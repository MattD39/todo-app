"use client";

import Link from "next/link";
import { useState } from "react";
import { formatMonth, monthGrid, relDay, type Now } from "@/lib/dates";
import type { HistoryDTO, TaskDTO, TickDTO } from "@/lib/tasks";
import { dayHistory, setCategoryParams, type DayMark } from "@/lib/views";
import { TaskGroup } from "./task-list";
import { Status } from "./status";

// The month grid on the Calendar screen, and the selected day's tasks under it.
//
// The selected day lives in the address bar (/calendar?day=2026-11-21) so a
// refresh keeps it. Tapping a day in the month on screen just updates the
// address in place (no trip to the server, so it's instant). Changing month
// is a normal page visit, because later steps load that month's history.

export function calendarHref(day: string, picked: string[]) {
  const params = new URLSearchParams({ day });
  setCategoryParams(params, picked); // the category chips that are on
  return `/calendar?${params}`;
}

export function MonthCalendar({
  initialDay,
  open,
  marks,
  repeats,
  history,
  now,
  timeZone,
  picked,
}: {
  initialDay: string;
  open: TaskDTO[]; // unfinished tasks, already filtered by category
  marks: Record<string, DayMark>;
  repeats: Record<string, string[]>; // day → ids of weekly/monthly tasks repeating then
  history: HistoryDTO; // what was finished on the days on screen, filtered by category
  now: Now;
  timeZone: string;
  picked: string[]; // the category chips that are on (none = All)
}) {
  const [selected, setSelected] = useState(initialDay);
  const { today } = now;
  const month = initialDay.slice(0, 7);
  const days = monthGrid(initialDay);
  const dayTasks = open.filter((t) => t.dueDate === selected);
  const repeatIds = repeats[selected] ?? [];
  const dayRepeats = open.filter((t) => repeatIds.includes(t.id));
  const { finished, movedOn } = dayHistory(history, selected, timeZone);
  const isEmpty = !dayTasks.length && !dayRepeats.length && !finished.length && !movedOn.length;

  // Prev/next month: lands on today if it's in that month, otherwise the 1st.
  const monthLink = (offset: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + offset, 1));
    const target = d.toISOString().slice(0, 7);
    return calendarHref(today.startsWith(target) ? today : `${target}-01`, picked);
  };

  const select = (day: string) => {
    setSelected(day);
    // replaceState, not pushState: tapping through ten days shouldn't take
    // ten presses of Back to leave the screen.
    window.history.replaceState(null, "", calendarHref(day, picked));
  };

  return (
    <>
      <div className="mt-4 rounded-[14px] border border-line bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <MonthButton href={monthLink(-1)} label="Previous month" path="m15 18-6-6 6-6" />
          <h2 className="font-display text-[1.15rem] font-bold">{formatMonth(initialDay)}</h2>
          <MonthButton href={monthLink(1)} label="Next month" path="m9 18 6-6-6-6" />
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <div key={i} aria-hidden className="py-1 font-mono text-[0.68rem] font-medium text-muted uppercase">
              {d}
            </div>
          ))}

          {days.map((day) => {
            const inMonth = day.startsWith(month);
            const isSelected = day === selected;
            const isToday = day === today;
            const mark = marks[day];
            const className = `flex aspect-[1/1.05] flex-col items-center justify-center gap-[3px] rounded-[10px] tabular-nums ${
              isSelected ? "bg-ink text-bg" : ""
            } ${inMonth ? "" : "text-muted opacity-45"}`;
            const label = [
              relDay(day, today),
              mark?.count && `${mark.count} ${mark.count === 1 ? "task" : "tasks"}`,
              mark?.repeats && `${mark.repeats} ${mark.repeats === 1 ? "repeat" : "repeats"}`,
            ]
              .filter(Boolean)
              .join(", ");
            const content = (
              <>
                <span
                  className={
                    isToday && !isSelected ? "rounded-full bg-accent-soft px-1.5 font-bold text-accent" : undefined
                  }
                >
                  {Number(day.slice(8))}
                </span>
                <Dots mark={mark} onDark={isSelected} />
              </>
            );

            // Greyed-out days from the neighbouring month switch to that month.
            return inMonth ? (
              <button
                key={day}
                type="button"
                onClick={() => select(day)}
                aria-label={label}
                aria-pressed={isSelected}
                // Enter on the day that's already selected opens Add task for
                // that day (see AddTaskButton) instead of selecting it again.
                data-enter-adds-task={isSelected ? "" : undefined}
                className={className}
              >
                {content}
              </button>
            ) : (
              <Link key={day} href={calendarHref(day, picked)} aria-label={label} className={className}>
                {content}
              </Link>
            );
          })}
        </div>
      </div>

      <TaskGroup
        title={relDay(selected, today)}
        tasks={dayTasks}
        now={now}
        timeZone={timeZone}
        warn={selected < today}
      />
      <TaskGroup title="Repeats here" tasks={dayRepeats} now={now} timeZone={timeZone} planned />
      <MovedOn ticks={movedOn} today={today} />
      <TaskGroup
        title="Finished"
        tasks={finished}
        now={now}
        timeZone={timeZone}
        isLocked={(t) => "isLatest" in t && !t.isLatest}
      />
      {isEmpty && (
        <Status>
          Nothing on {relDay(selected, today)}. Tap <b>Add task</b> to add one for this day.
        </Status>
      )}
    </>
  );
}

// Repeating tasks that were due on this day but ticked on another day, so
// they don't seem to have vanished: "✓ Chest workout · Done early on Tue,
// Nov 17 · Next: Sat, Nov 28". Just for show — undo it from the day it was done.
function MovedOn({ ticks, today }: { ticks: TickDTO[]; today: string }) {
  if (ticks.length === 0) return null;
  return (
    <ul aria-label="Moved on" className="mt-[18px] flex flex-col gap-1.5 px-1 text-[0.86rem] text-muted">
      {ticks.map((t) => (
        <li key={t.completionId} className="flex gap-2">
          <span aria-hidden className="text-accent">
            ✓
          </span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <b className="font-bold">{t.title}</b>
            {" · "}
            Done {t.completedOn < (t.previousDueDate ?? "") ? "early" : "late"} on {relDay(t.completedOn, today)}
            {t.dueDate && (
              <>
                {" · "}
                <span className="font-mono text-[0.78rem]">Next: {relDay(t.dueDate, today)}</span>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Up to three dots per day: solid for tasks due that day (red if any is
// overdue), then faint ones for later repeats. The empty row keeps every day
// the same height.
function Dots({ mark, onDark }: { mark: DayMark | undefined; onDark: boolean }) {
  const solid = Math.min(mark?.count ?? 0, 3);
  const faint = Math.min(mark?.repeats ?? 0, 3 - solid);
  const color = onDark ? "bg-bg" : mark?.overdue ? "bg-high" : "bg-accent";
  const faintColor = onDark ? "bg-bg opacity-40" : "bg-accent opacity-30";
  return (
    <span aria-hidden className="flex h-[5px] gap-0.5">
      {Array.from({ length: solid + faint }, (_, i) => (
        <i key={i} className={`size-[5px] rounded-full ${i < solid ? color : faintColor}`} />
      ))}
    </span>
  );
}

function MonthButton({ href, label, path }: { href: string; label: string; path: string }) {
  return (
    <Link href={href} aria-label={label} className="grid size-9 place-items-center rounded-[10px] bg-sunk">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        aria-hidden
      >
        <path d={path} />
      </svg>
    </Link>
  );
}
