"use client";

import { startTransition, useOptimistic } from "react";
import type { TaskDTO } from "@/lib/tasks";
import { markTaskDone } from "@/app/task-actions";
import { useToast } from "./task-editor";

// The round tick box at the start of each task row. Tapping it marks the task
// done (or not done). The tick appears straight away ("optimistic"), before
// the server has answered; if saving fails it undoes itself and says why.
export function CheckButton({ task }: { task: Pick<TaskDTO, "id" | "title" | "done" | "priority"> }) {
  const [done, setDone] = useOptimistic(task.done);
  const toast = useToast();

  function toggle() {
    startTransition(async () => {
      const next = !done;
      setDone(next);
      const { error } = await markTaskDone(task.id, next);
      if (error) toast(error);
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
      aria-label={done ? `Mark "${task.title}" as not done` : `Mark "${task.title}" as done`}
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
