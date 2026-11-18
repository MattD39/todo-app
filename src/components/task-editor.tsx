"use client";

import {
  createContext,
  startTransition,
  use,
  useActionState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { flushSync } from "react-dom";
import type { TaskDTO } from "@/lib/tasks";
import { isValidDay } from "@/lib/dates";
import { removeTask, saveTask, type SaveTaskState } from "@/app/task-actions";
import { dateTimeFix, fieldLabel, input, segment } from "./form-styles";
import { StepsEditor } from "./steps-editor";
import { useBackdropClose } from "./use-backdrop-close";
import { useFitVisibleScreen } from "./use-fit-visible-screen";

// Everything for adding and editing tasks:
//   • TaskEditorProvider — wraps a screen; owns "is the editor open, and for which task?"
//   • OpenTaskButton    — makes a task row tappable to edit it
//   • the floating "Add task" button and the bottom-sheet form itself
//   • useToast()        — shows a short message at the bottom ("Task deleted")
//
// This runs in the browser ("use client") so the sheet opens instantly.
// Saving goes to the server through saveTask().

// A new task can start with a date filled in (the day picked on the Calendar).
type Editing = { mode: "new"; dueDate?: string } | { mode: "edit"; task: TaskDTO };

const OpenEditor = createContext<(editing: Editing) => void>(() => {});
// A toast can carry one button, e.g. Undo.
type ToastAction = { label: string; onClick: () => void };
type Toast = { message: string; action?: ToastAction };

const ShowToast = createContext<(message: string, action?: ToastAction) => void>(() => {});

export function useToast() {
  return use(ShowToast);
}

// Suggested in the Category box until you've made your own.
const STARTER_CATEGORIES = ["Personal", "Fitness", "Business", "Errands"];

export function TaskEditorProvider({
  categories,
  defaultCategory,
  today,
  showAddButton = true,
  children,
}: {
  categories: string[];
  defaultCategory: string | null; // the filter chip that's on, if any — new tasks start in it
  today: string; // in the user's time zone
  showAddButton?: boolean; // the floating "Add task" button (off on the Chat tab, where it would cover Send)
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  // Bumped on every open so the form starts fresh each time.
  const [openCount, setOpenCount] = useState(0);

  const open = useCallback((next: Editing) => {
    setEditing(next);
    setOpenCount((n) => n + 1);
  }, []);
  const close = useCallback(() => setEditing(null), []);

  const [currentToast, setCurrentToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideToast = useCallback(() => {
    clearTimeout(toastTimer.current);
    setCurrentToast(null);
  }, []);
  const toast = useCallback((message: string, action?: ToastAction) => {
    setCurrentToast({ message, action });
    clearTimeout(toastTimer.current);
    // Longer when there's a button, so there's time to tap it.
    toastTimer.current = setTimeout(() => setCurrentToast(null), action ? 6000 : 2600);
  }, []);

  const suggestions = [...new Set([...categories, ...STARTER_CATEGORIES])];

  return (
    <OpenEditor value={open}>
      <ShowToast value={toast}>
        {children}
        {showAddButton && <AddTaskButton onClick={() => open({ mode: "new", dueDate: calendarDay(today) })} />}
        {editing && (
          <TaskSheet
            key={openCount}
            editing={editing}
            suggestions={suggestions}
            defaultCategory={defaultCategory}
            onClose={close}
          />
        )}
        {/* aria-live: screen readers announce the message when it appears. */}
        <div role="status" aria-live="polite">
          {currentToast && (
            <div className="fixed bottom-[calc(64px+86px+env(safe-area-inset-bottom,0px))] left-1/2 z-30 flex w-max max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3 rounded-full bg-ink px-4 py-2.5 text-center text-[0.9rem] text-bg">
              <span>{currentToast.message}</span>
              {currentToast.action && (
                <button
                  type="button"
                  onClick={() => {
                    const { onClick } = currentToast.action!;
                    hideToast();
                    onClick();
                  }}
                  // Negative margin: a bigger tap target without a taller bar.
                  className="-my-2 -mr-2 rounded-full px-2 py-2 font-bold text-accent-soft underline underline-offset-2"
                >
                  {currentToast.action.label}
                </button>
              )}
            </div>
          )}
        </div>
      </ShowToast>
    </OpenEditor>
  );
}

// On the Calendar, a new task starts on the selected day. That day is read
// from the address bar (/calendar?day=2026-11-21), which the Calendar keeps
// up to date as you tap days; no ?day= means today, as on the Calendar itself.
// Other screens start with no date.
function calendarDay(today: string): string | undefined {
  if (window.location.pathname !== "/calendar") return undefined;
  const day = new URLSearchParams(window.location.search).get("day");
  return day && isValidDay(day) ? day : today;
}

export function OpenTaskButton({
  task,
  className,
  children,
}: {
  task: TaskDTO;
  className?: string;
  children: React.ReactNode;
}) {
  const open = use(OpenEditor);
  return (
    <button type="button" className={className} onClick={() => open({ mode: "edit", task })}>
      {children}
    </button>
  );
}

// Opens a new task with the cursor already in the title box and the keyboard
// up. iPhone Safari only opens the keyboard if a text box is focused during
// the tap itself, not a moment later, so everything here happens inside the
// tap:
//   1. focus an invisible text box that's always on the page. That alone
//      makes the iPhone open its keyboard (the backup plan);
//   2. flushSync draws and opens the sheet right now instead of a moment
//      later, and the sheet focuses its title box as it opens (see TaskSheet).
// Moving focus from one text box to another keeps the keyboard up.
function AddTaskButton({ onClick }: { onClick: () => void }) {
  const keyboardOpener = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={keyboardOpener}
        data-keyboard-opener=""
        aria-hidden
        tabIndex={-1}
        autoComplete="off"
        // Invisible, but not display:none (that couldn't take focus). 16px text
        // stops the iPhone zooming in on it.
        className="pointer-events-none fixed top-0 left-0 size-px text-base opacity-0"
      />
      <AddTaskFab
        onClick={() => {
          keyboardOpener.current?.focus({ preventScroll: true });
          flushSync(onClick);
        }}
      />
    </>
  );
}

function AddTaskFab({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed right-[calc(max(16px,env(safe-area-inset-right,0px))+4px)] bottom-[calc(64px+18px+env(safe-area-inset-bottom,0px))] z-[7] flex h-[54px] items-center gap-1.5 rounded-full bg-accent pr-5 pl-4 font-bold text-accent-ink shadow-[0_6px_18px_rgba(0,0,0,.18)]"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        className="size-[22px]"
        aria-hidden
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
      Add task
    </button>
  );
}

const PRIORITY_OPTIONS = [
  { value: "high", label: "High", checkedColor: "has-checked:text-high" },
  { value: "medium", label: "Medium", checkedColor: "has-checked:text-med" },
  { value: "low", label: "Low", checkedColor: "has-checked:text-ink" },
] as const;

// "" = doesn't repeat (the form sends a blank value).
const REPEAT_OPTIONS = [
  { value: "", label: "Never" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
] as const;

function TaskSheet({
  editing,
  suggestions,
  defaultCategory,
  onClose,
}: {
  editing: Editing;
  suggestions: string[];
  defaultCategory: string | null;
  onClose: () => void;
}) {
  const task = editing.mode === "edit" ? editing.task : null;
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Tracked so the time box can be switched off when there's no date.
  const [dueDate, setDueDate] = useState(task?.dueDate ?? (editing.mode === "new" ? (editing.dueDate ?? "") : ""));

  const [state, save, saving] = useActionState(
    async (prev: SaveTaskState, formData: FormData) => {
      const result = await saveTask(prev, formData);
      if (!result.error) onClose();
      return result;
    },
    { error: null, savedAt: null },
  );

  // <dialog>'s showModal() gives us, for free: the dimmed background, Escape
  // to close, and keyboard focus kept inside the sheet.
  // A layout effect, so when Add task opens the sheet with flushSync this all
  // happens inside the tap; then a new task's title box can be focused with
  // the keyboard opening on the iPhone too. An existing task focuses nothing
  // you type in, so no keyboard pops up.
  const titleRef = useRef<HTMLInputElement>(null);
  const isNew = !task;
  useLayoutEffect(() => {
    dialogRef.current?.showModal();
    if (isNew) titleRef.current?.focus();
  }, [isNew]);
  useFitVisibleScreen(dialogRef);
  const backdropClose = useBackdropClose(onClose);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="sheet-title"
      onClose={() => {
        // Closing with Escape hands focus back to whatever had it before the
        // sheet opened: for Add task, the invisible keyboard opener. Let go of
        // it so typing doesn't vanish into it (and no keyboard pops up).
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.dataset.keyboardOpener !== undefined) active.blur();
        onClose();
      }}
      // A tap on the dimmed area (the dialog itself, outside the panel) closes it.
      {...backdropClose}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-[rgba(10,16,12,.45)]"
    >
      {/* scroll-pt keeps a box you tap from hiding under the sticky top bar. */}
      <div className="sheet-in absolute inset-x-0 bottom-0 mx-auto max-h-[92%] w-full max-w-[640px] scroll-pt-20 overflow-y-auto overscroll-contain rounded-t-[18px] bg-bg px-[max(16px,env(safe-area-inset-left,0px))] pb-[calc(20px+env(safe-area-inset-bottom,0px))] text-ink">
        {/* The top bar stays put while the form scrolls under it, iPhone-style:
            Close on the left, Add / Save on the right, always in reach. */}
        <div className="sticky top-0 z-10 -mx-1 mb-2 bg-bg px-1 pt-2.5 pb-2">
          <div className="mx-auto mb-2 h-1 w-10 rounded bg-line" aria-hidden />
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <button type="button" onClick={onClose} className="justify-self-start py-1.5 pr-3 text-muted">
              Close
            </button>
            <h2 id="sheet-title" className="font-display text-[1.2rem] font-bold">
              {task ? "Edit task" : "New task"}
            </h2>
            {/* Lives outside the <form>; form="task-form" still makes it the form's save button. */}
            <button
              type="submit"
              form="task-form"
              disabled={saving}
              className="justify-self-end rounded-full bg-accent px-4 py-1.5 font-bold text-accent-ink disabled:opacity-60"
            >
              {saving ? "Saving…" : task ? "Save" : "Add"}
            </button>
          </div>
          {state.error && (
            <p role="alert" className="mt-2 text-[0.9rem] font-bold text-high">
              {state.error}
            </p>
          )}
        </div>

        <form
          id="task-form"
          className="flex flex-col gap-3.5"
          // Enter in a one-line box just closes the keyboard: saving is the Add /
          // Save button (or Ctrl/⌘+Enter on a computer). Boxes that use Enter
          // themselves (Add step, Ask Claude) handle it first and are left alone;
          // Notes is a <textarea>, where Enter starts a new line as usual.
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing || e.defaultPrevented) return;
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              e.currentTarget.requestSubmit();
              return;
            }
            if (e.target instanceof HTMLInputElement) {
              e.preventDefault();
              e.target.blur();
            }
          }}
          // Submitting this way (instead of <form action>) keeps what you typed
          // in the boxes if saving fails, so you can fix it and try again.
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            startTransition(() => save(formData));
          }}
        >
          {task && <input type="hidden" name="id" value={task.id} />}

          <label className={fieldLabel}>
            Task
            <input
              name="title"
              required
              maxLength={200}
              defaultValue={task?.title}
              placeholder="e.g. Call the bank"
              ref={titleRef}
              autoComplete="off"
              enterKeyHint="done"
              className={input}
            />
          </label>

          <label className={fieldLabel}>
            Category
            <input
              name="category"
              list="category-suggestions"
              maxLength={40}
              defaultValue={task ? task.category?.name : (defaultCategory ?? undefined)}
              placeholder="Personal"
              autoComplete="off"
              enterKeyHint="done"
              className={input}
            />
            <datalist id="category-suggestions">
              {suggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>

          <fieldset className={fieldLabel}>
            <legend className="mb-[5px]">Priority</legend>
            <div className="grid grid-cols-3 gap-[3px] rounded-[10px] bg-sunk p-[3px]">
              {PRIORITY_OPTIONS.map((p) => (
                <label key={p.value} className={`${segment} ${p.checkedColor}`}>
                  <input
                    type="radio"
                    name="priority"
                    value={p.value}
                    defaultChecked={(task?.priority ?? "medium") === p.value}
                    className="sr-only"
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-2.5">
            <label className={fieldLabel}>
              Due date
              <input
                type="date"
                name="dueDate"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className={`${input} ${dateTimeFix}`}
              />
            </label>
            <label className={fieldLabel}>
              Time (optional)
              <input
                type="time"
                name="dueTime"
                defaultValue={task?.dueTime ?? ""}
                disabled={!dueDate}
                className={`${input} ${dateTimeFix}`}
              />
            </label>
          </div>

          <fieldset className={fieldLabel}>
            <legend className="mb-[5px]">Repeats</legend>
            <div className="grid grid-cols-4 gap-[3px] rounded-[10px] bg-sunk p-[3px]">
              {REPEAT_OPTIONS.map((r) => (
                <label key={r.value} className={`${segment} has-checked:text-ink`}>
                  <input
                    type="radio"
                    name="repeat"
                    value={r.value}
                    defaultChecked={(task?.repeat ?? "") === r.value}
                    className="sr-only"
                  />
                  {r.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className={fieldLabel}>
            Notes
            <textarea
              name="notes"
              maxLength={5000}
              defaultValue={task?.notes}
              placeholder="Phone numbers, links, details"
              className={`${input} min-h-[72px] resize-y`}
            />
          </label>

          <StepsEditor taskId={task?.id ?? null} initialSteps={task?.steps ?? []} />
        </form>

        {task && <DeleteButton taskId={task.id} onDeleted={onClose} />}
      </div>
    </dialog>
  );
}

// Delete needs two taps: the first turns the button red and asks again, so a
// stray tap can't delete anything. It calms down again after a few seconds.
function DeleteButton({ taskId, onDeleted }: { taskId: string; onDeleted: () => void }) {
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, startDeleting] = useTransition();
  const toast = useToast();

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  function handleClick() {
    if (!armed) {
      setError(null);
      setArmed(true);
      return;
    }
    startDeleting(async () => {
      const result = await removeTask(taskId);
      if (result.error) {
        setError(result.error);
        setArmed(false);
      } else {
        onDeleted();
        toast("Task deleted");
      }
    });
  }

  return (
    <div className="mt-3.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={deleting}
        className={`w-full rounded-xl border p-[11px] font-bold disabled:opacity-60 ${
          armed ? "border-high bg-high text-bg" : "border-line text-high"
        }`}
      >
        {deleting ? "Deleting…" : armed ? "Tap again to delete" : "Delete task"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-[0.9rem] font-bold text-high">
          {error}
        </p>
      )}
    </div>
  );
}
