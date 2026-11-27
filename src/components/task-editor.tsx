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
import { addedTaskMessage, type AddScreen } from "@/lib/views";
import { removeTask, saveTask, type AddedTask, type SaveTaskState } from "@/app/task-actions";
import { dateTimeFix, fieldLabel, input, segment } from "./form-styles";
import { StepsEditor } from "./steps-editor";
import { useBackdropClose } from "./use-backdrop-close";
import { useFitVisibleScreen } from "./use-fit-visible-screen";
import { useSwipeToClose } from "./use-swipe-to-close";
import { useEditMode } from "./edit-mode";
import { CategoryField } from "./category-field";
import { showAddedTask } from "./added-glow";

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

const ShowToast = createContext<(message: string, action?: ToastAction, ms?: number) => void>(() => {});

export function useToast() {
  return use(ShowToast);
}

export function TaskEditorProvider({
  savedCategories,
  defaultCategory,
  today,
  screen,
  picked,
  showAddButton = true,
  enterToAdd = false,
  children,
}: {
  savedCategories: string[]; // the saved list, offered in the Category box
  defaultCategory: string | null; // the filter chip that's on, if any — new tasks start in it
  today: string; // in the user's time zone
  screen: AddScreen | null; // the screen this is on (null: Chat, which has no Add task)
  picked: string[]; // the category chips that are on (none = All)
  showAddButton?: boolean; // the floating "Add task" button (off on the Chat tab, where it would cover Send)
  enterToAdd?: boolean; // Enter opens Add task on a computer (Today, Upcoming, Calendar)
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const selecting = useEditMode()?.editing ?? false; // edit mode on the task list
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
  const toast = useCallback((message: string, action?: ToastAction, ms?: number) => {
    setCurrentToast({ message, action });
    clearTimeout(toastTimer.current);
    // Longer when there's a button, so there's time to tap it.
    toastTimer.current = setTimeout(() => setCurrentToast(null), ms ?? (action ? 6000 : 2600));
  }, []);

  // A task was just added from the Add task sheet: if it won't show on this
  // screen (another screen, or hidden by the chips), say where it went.
  const onAdded = useCallback(
    (added: AddedTask) => {
      if (!screen) return;
      const { message, glow } = addedTaskMessage(added, {
        screen,
        today,
        picked,
        calendarDay: calendarDay(today) ?? today,
      });
      if (message) toast(message, undefined, 2000);
      // It's on this screen: scroll to it and make it glow. If its row
      // never shows up, at least say it was added.
      else if (glow) showAddedTask(added.id, () => toast("Added", undefined, 2000));
    },
    [screen, today, picked, toast],
  );

  return (
    <OpenEditor value={open}>
      <ShowToast value={toast}>
        {children}
        {/* Hidden in edit mode (selecting tasks), and with it Enter-to-add. */}
        {showAddButton && !selecting && (
          <AddTaskButton enterToAdd={enterToAdd} onClick={() => open({ mode: "new", dueDate: calendarDay(today) })} />
        )}
        {editing && (
          <TaskSheet
            key={openCount}
            editing={editing}
            savedCategories={savedCategories}
            defaultCategory={defaultCategory}
            onClose={close}
            onAdded={onAdded}
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
function AddTaskButton({ onClick, enterToAdd }: { onClick: () => void; enterToAdd: boolean }) {
  const keyboardOpener = useRef<HTMLInputElement>(null);
  const press = useCallback(() => {
    keyboardOpener.current?.focus({ preventScroll: true });
    flushSync(onClick);
  }, [onClick]);

  // On a computer, Enter opens Add task, like clicking the button. Only when
  // nothing else is going on: never while a sheet or pop-up is open, never in
  // a box you type in, and never when a button or link has the keyboard
  // highlight (moved to with Tab), because Enter presses that one. A button
  // you just clicked with the mouse has no highlight, so Enter adds a task
  // (e.g. click a day on the Calendar, then Enter adds one on that day).
  useEffect(() => {
    if (!enterToAdd) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.repeat || e.isComposing || e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (document.querySelector("dialog[open]")) return;
      const target = e.target;
      if (target instanceof Element && target !== document.body) {
        if (target.closest("input, textarea, select, [contenteditable]")) return;
        // A highlighted button keeps its Enter, except one marked to pass it
        // on (the Calendar's already-selected day).
        if (target.matches(":focus-visible") && !target.closest("[data-enter-adds-task]")) return;
      }
      e.preventDefault(); // so a clicked button isn't pressed again as well
      press();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enterToAdd, press]);

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
      <AddTaskFab onClick={press} />
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
  savedCategories,
  defaultCategory,
  onClose,
  onAdded,
}: {
  editing: Editing;
  savedCategories: string[];
  defaultCategory: string | null;
  onClose: () => void;
  onAdded: (added: AddedTask) => void;
}) {
  const task = editing.mode === "edit" ? editing.task : null;
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Tracked so the time box can be switched off when there's no date.
  const [dueDate, setDueDate] = useState(task?.dueDate ?? (editing.mode === "new" ? (editing.dueDate ?? "") : ""));

  const [state, save, saving] = useActionState(
    async (prev: SaveTaskState, formData: FormData) => {
      const result = await saveTask(prev, formData);
      if (!result.error) {
        onClose();
        if (result.added) onAdded(result.added);
      }
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
  // Swipe down to close (iPhone): the panel both slides and scrolls.
  const panelRef = useRef<HTMLDivElement>(null);
  useSwipeToClose(panelRef, panelRef, onClose);

  // Enter when you're not in any box saves the task, like the Add / Save
  // button (e.g. Enter in the title closes it; Enter again saves). (With nothing selected, the browser sends keys to the page, not
  // to the form, so this listens on the whole page while the sheet is open.)
  // Left alone: a box you type in (the form's onKeyDown handles those),
  // buttons and links (Enter presses them), and the time another pop-up,
  // like the sign-in box, is open on top of the sheet.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.repeat || e.isComposing || e.defaultPrevented || saving) return;
      const dialog = dialogRef.current;
      if (!dialog?.open) return;
      if ([...document.querySelectorAll("dialog[open]")].some((d) => d !== dialog)) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target !== document.body && !dialog.contains(target)) return;
      if (target.closest("input, textarea, select, button, a[href], summary, [contenteditable]")) return;
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [saving]);

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
      <div
        ref={panelRef}
        className="sheet-in absolute inset-x-0 bottom-0 mx-auto max-h-[92%] w-full max-w-[640px] scroll-pt-20 overflow-y-auto overscroll-contain rounded-t-[18px] bg-bg px-[max(16px,env(safe-area-inset-left,0px))] pb-[calc(20px+env(safe-area-inset-bottom,0px))] text-ink"
      >
        {/* The top bar stays put while the form scrolls under it, iPhone-style:
            Close on the left, Add / Save on the right, always in reach. */}
        <div data-sheet-handle className="sticky top-0 z-10 -mx-1 mb-2 bg-bg px-1 pt-2.5 pb-2">
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
          ref={formRef}
          id="task-form"
          className="flex flex-col gap-3.5"
          // Enter in a one-line box just closes the keyboard (Done on the iPhone);
          // a second Enter, now outside any box, saves (see onKeyDown above).
          // Ctrl/⌘+Enter saves from anywhere on a computer. Boxes that use Enter
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

          <CategoryField
            saved={savedCategories}
            initial={task ? (task.category?.name ?? "") : (defaultCategory ?? "")}
            labelClassName={fieldLabel}
            inputClassName={input}
          />

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
        toast("Deleted · it's in Settings → Recently deleted");
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
