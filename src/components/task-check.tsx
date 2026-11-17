"use client";

import { startTransition, useOptimistic, useState } from "react";
import type { TaskDTO } from "@/lib/tasks";
import { earlyTick, formatDay } from "@/lib/dates";
import { markTaskDone, undoTick } from "@/app/task-actions";
import { useToast } from "./task-editor";
import { ConfirmDialog } from "./confirm-dialog";

// The round tick box at the start of each task row. Tapping it marks the task
// done (or not done). The tick appears straight away ("optimistic"), before
// the server has answered; if saving fails it undoes itself and says why.
//
// Repeating tasks: ticking one moves it to its next date and shows
// "Done. Next one: …" with an Undo button. Its entry under "Finished today"
// can also be unticked, which undoes that tick the same way.
//
// Ticking a repeating task before its due day asks first ("Mark it done
// early?"), so a stray tap can't skip a week.
//
// locked: an older tick in the Calendar's history. Only a task's most recent
// tick can be undone (undoing puts the task back to its date before that
// tick), so older ones show as ticked but can't be tapped.
export function CheckButton({
  task,
  today,
  locked = false,
}: {
  task: Pick<TaskDTO, "id" | "title" | "done" | "priority" | "completionId" | "repeat" | "dueDate">;
  today: string;
  locked?: boolean;
}) {
  const [done, setDone] = useOptimistic(task.done);
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();
  const early = !task.done && !task.completionId ? earlyTick(task, today) : null;
  const withYear = (day: string) => formatDay(day, { withYear: day.slice(0, 4) !== today.slice(0, 4) });

  async function undo(completionId: string) {
    const { error } = await undoTick(completionId);
    toast(error ?? "Tick undone");
  }

  function toggle() {
    if (early && !done) {
      setConfirming(true);
      return;
    }
    save();
  }

  function save() {
    startTransition(async () => {
      const next = !done;
      setDone(next);
      if (task.completionId) {
        await undo(task.completionId);
        return;
      }
      const result = await markTaskDone(task.id, next);
      if (result.error) toast(result.error);
      else if (result.undo) {
        const { completionId, message } = result.undo;
        toast(message, {
          label: "Undo",
          onClick: () => startTransition(() => undo(completionId)),
        });
      }
    });
  }

  const ring = done
    ? "border-accent bg-accent text-accent-ink"
    : task.priority === "high"
      ? "border-high text-muted"
      : task.priority === "medium"
        ? "border-med text-muted"
        : "border-muted text-muted";

  return (
    <>
      {/* The padding + negative margin make a bigger, easier-to-tap target (44px)
        without making the circle itself bigger. */}
      <button
        type="button"
        onClick={toggle}
        disabled={locked}
        title={locked ? "Only the most recent tick can be undone" : undefined}
        aria-label={
          locked
            ? `"${task.title}" was ticked (only the most recent tick can be undone)`
            : task.completionId
            ? `Undo ticking "${task.title}"`
            : done
              ? `Mark "${task.title}" as not done`
              : `Mark "${task.title}" as done`
        }
        className="group -m-[9px] flex-none p-[9px] disabled:opacity-45"
      >
        <span className={`mt-px grid size-[26px] place-items-center rounded-full border-2 ${ring}`}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className={`size-3.5 ${done ? "opacity-100" : "opacity-0 group-hover:opacity-35"}`}
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      </button>
      {confirming && early && (
        <ConfirmDialog
          title="Mark it done early?"
          confirmLabel="Mark done"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            save();
          }}
        >
          <p>
            <b className="text-ink">{task.title}</b> is due {withYear(early.dueDate)}.
          </p>
          <p className="mt-1">Next one: {withYear(early.nextDate)}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
