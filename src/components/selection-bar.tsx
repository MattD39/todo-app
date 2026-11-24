"use client";

import { useState } from "react";
import { deleteSelected } from "@/app/task-actions";
import { useEditMode } from "./edit-mode";
import { useToast } from "./task-editor";

// The bar at the bottom in edit mode: Cancel · Select all · Delete (N). It
// covers the tab bar while you're selecting, so you can't leave the screen
// half-way through. Delete removes everything selected at once; each whole
// task goes into Recently deleted (Settings), the same as swipe to delete.
// (Undo after a batch delete comes next, in step c.)
export function SelectionBar() {
  const edit = useEditMode();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  if (!edit?.editing) return null;

  const count = edit.selected.size;
  const allSelected = edit.onScreen.size > 0 && [...edit.onScreen].every((key) => edit.selected.has(key));

  async function remove() {
    if (!edit || count === 0 || deleting) return;
    setDeleting(true);
    const targets = [...edit.selected].map((key) =>
      key.startsWith("tick:") ? { completionId: key.slice(5) } : { taskId: key.slice(5) },
    );
    const result = await deleteSelected(targets);
    setDeleting(false);
    if (result.error || !result.value) {
      toast(result.error ?? "Couldn't delete. Try again."); // still selected, so you can try again
      return;
    }
    edit.stop();
    toast(deletedMessage(result.value));
  }

  const button = "h-11 rounded-full px-4 font-bold disabled:opacity-40";
  return (
    <div
      role="toolbar"
      aria-label="Selected tasks"
      className="fixed inset-x-0 bottom-0 z-[7] flex h-[calc(4rem+env(safe-area-inset-bottom,0px))] items-start justify-between gap-2 border-t border-line bg-surface pt-2.5 pr-[max(16px,env(safe-area-inset-right,0px))] pb-[env(safe-area-inset-bottom,0px)] pl-[max(16px,env(safe-area-inset-left,0px))]"
    >
      <button type="button" onClick={edit.stop} disabled={deleting} className={`${button} text-accent`}>
        Cancel
      </button>
      <button
        type="button"
        onClick={allSelected ? edit.selectNone : edit.selectAll}
        disabled={deleting || edit.onScreen.size === 0}
        className={`${button} text-accent`}
      >
        {allSelected ? "Select none" : "Select all"}
      </button>
      <button
        type="button"
        onClick={remove}
        disabled={deleting || count === 0}
        className={`${button} bg-high text-white`}
      >
        {deleting ? "Deleting…" : `Delete (${count})`}
      </button>
    </div>
  );
}

// "Deleted 3 tasks", "Deleted 2 tasks and 1 entry", "… (1 was already gone)".
function deletedMessage({ tasks, entries, missing }: { tasks: number; entries: number; missing: number }): string {
  const parts = [];
  if (tasks > 0) parts.push(`${tasks} ${tasks === 1 ? "task" : "tasks"}`);
  if (entries > 0) parts.push(`${entries} ${entries === 1 ? "entry" : "entries"}`);
  const gone = missing > 0 ? ` (${missing} ${missing === 1 ? "was" : "were"} already gone)` : "";
  if (parts.length === 0) return `Nothing deleted${gone}`;
  return `Deleted ${parts.join(" and ")}${gone}`;
}
