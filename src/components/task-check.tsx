"use client";

import { startTransition, useOptimistic } from "react";
import type { TaskDTO } from "@/lib/tasks";
import { markTaskDone, undoTick } from "@/app/task-actions";
import { useToast } from "./task-editor";

// The round tick box at the start of each task row. Tapping it marks the task
// done (or not done). The tick appears straight away ("optimistic"), before
// the server has answered; if saving fails it undoes itself and says why.
//
// Repeating tasks: ticking one moves it to its next date and shows
// "Done. Next one: …" with an Undo button. Its entry under "Finished today"
// can also be unticked, which undoes that tick the same way.
export function CheckButton({
  task,
}: {
  task: Pick<TaskDTO, "id" | "title" | "done" | "priority" | "completionId">;
}) {
  const [done, setDone] = useOptimistic(task.done);
  const toast = useToast();

  async function undo(completionId: string) {
    const { error } = await undoTick(completionId);
    toast(error ?? "Tick undone");
  }

  function toggle() {
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
        toast(message, { label: "Undo", onClick: () => startTransition(() => undo(completionId)) });
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
    // The padding + negative margin make a bigger, easier-to-tap target (44px)
    // without making the circle itself bigger.
    <button
      type="button"
      onClick={toggle}
      aria-label={
        task.completionId
          ? `Undo ticking "${task.title}"`
          : done
            ? `Mark "${task.title}" as not done`
            : `Mark "${task.title}" as done`
      }
      className="group -m-[9px] flex-none p-[9px]"
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
  );
}
