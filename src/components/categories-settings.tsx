"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type RefObject } from "react";
import {
  addCategory,
  deleteCategory,
  getCategories,
  getCategoryUsage,
  renameSavedCategory,
  type CategoriesList,
} from "@/app/task-actions";
import type { ConfirmRequest } from "./recently-deleted";

// Settings → Categories: your saved categories ("like contacts"). Add one,
// rename one, or delete one (deleting is only possible here, after an "are you
// sure?" that says how many tasks will lose it). Below them, "Not saved":
// one-off categories some unfinished task uses, each with a Save button.
//
// Settings shows one row with how many are saved; tapping it opens this
// screen inside the same sheet, like Recently deleted.

// The lists and what the buttons do. Lives in the Settings sheet, so the
// lists stay loaded while you move between Settings and Categories.
export function useCategories(askConfirm: (request: ConfirmRequest) => void) {
  const [lists, setLists] = useState<CategoriesList | null>(null); // null = still loading
  const [loadError, setLoadError] = useState<string | null>(null);
  // The result of the last button: what changed, or what went wrong.
  const [note, setNote] = useState<{ text: string; isError: boolean } | null>(null);
  const [busy, startBusy] = useTransition(); // one button at a time
  const [renaming, setRenaming] = useState<string | null>(null); // the id being renamed

  const load = useCallback(async () => {
    const result = await getCategories();
    setLoadError(result.error);
    if (result.value) setLists(result.value);
  }, []);

  // Loaded when Settings opens, so its row can show how many are saved.
  useEffect(() => {
    let current = true;
    getCategories().then((result) => {
      if (!current) return; // Settings was closed meanwhile
      setLoadError(result.error);
      if (result.value) setLists(result.value);
    });
    return () => {
      current = false;
    };
  }, []);

  // onDone runs only if it worked (the Add box uses it to empty itself).
  function add(name: string, onDone?: () => void) {
    startBusy(async () => {
      setNote(null);
      const result = await addCategory(name);
      if (result.error || !result.value) {
        setNote({ text: result.error ?? "Couldn't save it. Try again.", isError: true });
        return;
      }
      const saved = result.value.name;
      setNote(
        result.value.alreadySaved
          ? { text: `“${saved}” is already on your list.`, isError: false }
          : { text: `“${saved}” is saved.`, isError: false },
      );
      onDone?.();
      await load();
    });
  }

  function rename(id: string, name: string) {
    startBusy(async () => {
      setNote(null);
      const result = await renameSavedCategory(id, name);
      if (result.error) {
        setNote({ text: result.error, isError: true }); // stays in rename mode, to fix it
        return;
      }
      setRenaming(null);
      setNote({ text: `Renamed to “${result.value}”.`, isError: false });
      await load();
    });
  }

  // Asks first, with how many tasks will lose it (finished ones included).
  function askDelete(id: string) {
    startBusy(async () => {
      setNote(null);
      const usage = await getCategoryUsage(id);
      if (usage.error || !usage.value) {
        setNote({ text: usage.error ?? "Couldn't check that category. Try again.", isError: true });
        await load();
        return;
      }
      const { name, tasks, finished } = usage.value;
      askConfirm({
        title: `Delete ${name}?`,
        body: deleteMessage(tasks, finished),
        confirmLabel: "Delete",
        onConfirm: () =>
          startBusy(async () => {
            const result = await deleteCategory(id);
            if (result.error) setNote({ text: result.error, isError: true });
            else setNote({ text: `“${name}” was deleted.`, isError: false });
            await load();
          }),
      });
    });
  }

  return {
    lists,
    loadError,
    note,
    clearNote: () => setNote(null),
    busy,
    renaming,
    startRenaming: (id: string) => {
      setNote(null);
      setRenaming(id);
    },
    stopRenaming: () => setRenaming(null),
    add,
    rename,
    askDelete,
  };
}

export type CategoriesState = ReturnType<typeof useCategories>;

// "12 tasks will lose this category (3 of them finished)."
function deleteMessage(tasks: number, finished: number): string {
  if (tasks === 0) return "No tasks use it, so nothing else changes.";
  const which = tasks === 1 ? "1 task" : `${tasks} tasks`;
  const done =
    finished === 0 ? "" : tasks === 1 ? " (it's finished)" : finished === tasks ? " (all finished)" : ` (${finished} of them finished)`;
  return `${which} will lose this category${done}. The tasks themselves stay.`;
}

// "2 tasks (1 finished)", "No tasks".
function usageLine(tasks: number, finished: number): string {
  if (tasks === 0) return "No tasks";
  const which = tasks === 1 ? "1 task" : `${tasks} tasks`;
  return finished > 0 ? `${which} (${finished} finished)` : which;
}

// The one row in Settings. `focusOnMount`: coming back from Categories, so
// the keyboard focus lands back on this row instead of being lost.
export function CategoriesRow({
  categories,
  onOpen,
  focusOnMount,
}: {
  categories: CategoriesState;
  onOpen: () => void;
  focusOnMount: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);

  const count = categories.loadError ? "" : categories.lists === null ? "…" : String(categories.lists.saved.length);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      className="mt-3.5 flex w-full items-center gap-2 rounded-[14px] border border-line bg-surface p-4 text-left"
    >
      <span className="flex-1 font-bold">Categories</span>
      <span className="text-muted" aria-label={count ? `${count} saved` : undefined}>
        {count}
      </span>
      <span aria-hidden className="text-[1.2rem] leading-none text-muted">
        ›
      </span>
    </button>
  );
}

// The full screen: a header with the way back, then (scrolling) the Add box,
// your saved categories and the one-offs in use.
export function CategoriesScreen({
  categories,
  onBack,
  scrollRef,
}: {
  categories: CategoriesState;
  onBack: () => void;
  scrollRef: RefObject<HTMLDivElement | null>; // what scrolls (for swipe down to close)
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);
  const [newName, setNewName] = useState("");
  const { lists, busy } = categories;
  const button = "rounded-xl p-2 text-[0.9rem] font-bold disabled:opacity-50";

  return (
    <>
      {/* The header is the handle: swiping down from it closes the sheet. */}
      <div data-sheet-handle className="flex-none px-[max(16px,env(safe-area-inset-left,0px))] pt-2.5 pb-2">
        <div className="mx-auto mb-2.5 h-1 w-10 rounded bg-line" aria-hidden />
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <button
            ref={backRef}
            type="button"
            onClick={onBack}
            className="justify-self-start py-1.5 pr-3 font-bold text-accent"
          >
            ‹ Settings
          </button>
          <h2 id="settings-title" className="font-display text-[1.2rem] font-bold">
            Categories
          </h2>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[max(16px,env(safe-area-inset-left,0px))] pb-[calc(16px+env(safe-area-inset-bottom,0px))]"
      >
        {/* Add a category to the saved list. */}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) categories.add(newName, () => setNewName(""));
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New category"
            aria-label="New category name"
            maxLength={40}
            className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2"
          />
          <button type="submit" disabled={busy || !newName.trim()} className={`${button} bg-accent px-4 text-accent-ink`}>
            Add
          </button>
        </form>

        {categories.note && (
          <p
            role={categories.note.isError ? "alert" : "status"}
            className={`mt-2 text-[0.9rem] ${categories.note.isError ? "font-bold text-high" : "text-ink"}`}
          >
            {categories.note.text}
          </p>
        )}

        {categories.loadError ? (
          <p role="alert" className="mt-3 text-[0.9rem] font-bold text-high">
            {categories.loadError}
          </p>
        ) : lists === null ? (
          <p className="mt-3 text-[0.9rem] text-muted">Loading…</p>
        ) : (
          <>
            <h3 className="mt-4 mb-2 font-mono text-[0.74rem] font-medium tracking-[0.08em] text-muted uppercase">
              Saved
            </h3>
            {lists.saved.length === 0 ? (
              <p className="text-[0.9rem] text-muted">No saved categories yet. Add one above.</p>
            ) : (
              <ul className="divide-y divide-line rounded-[14px] border border-line bg-surface px-4">
                {lists.saved.map((c) =>
                  categories.renaming === c.id ? (
                    <RenameRow key={c.id} name={c.name} categories={categories} id={c.id} />
                  ) : (
                    <li key={c.id} className="flex items-center gap-2 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium [overflow-wrap:anywhere]">{c.name}</p>
                        <p className="text-[0.82rem] text-muted">{usageLine(c.tasks, c.finished)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => categories.startRenaming(c.id)}
                        disabled={busy}
                        aria-label={`Rename ${c.name}`}
                        className={`${button} border border-line bg-bg px-3 text-accent`}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => categories.askDelete(c.id)}
                        disabled={busy}
                        aria-label={`Delete ${c.name}`}
                        className={`${button} border border-line bg-bg px-3 text-high`}
                      >
                        Delete
                      </button>
                    </li>
                  ),
                )}
              </ul>
            )}

            {lists.oneOffs.length > 0 && (
              <>
                <h3 className="mt-5 mb-1 font-mono text-[0.74rem] font-medium tracking-[0.08em] text-muted uppercase">
                  Not saved
                </h3>
                <p className="mb-2 text-[0.82rem] text-muted">
                  Typed for some tasks only. Their chip goes once those tasks are finished or deleted.
                </p>
                <ul className="divide-y divide-line rounded-[14px] border border-line bg-surface px-4">
                  {lists.oneOffs.map((c) => (
                    <li key={c.id} className="flex items-center gap-2 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium [overflow-wrap:anywhere]">{c.name}</p>
                        <p className="text-[0.82rem] text-muted">{usageLine(c.tasks, 0)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => categories.add(c.name)}
                        disabled={busy}
                        aria-label={`Save ${c.name} to your list`}
                        className={`${button} bg-accent px-4 text-accent-ink`}
                      >
                        Save
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

// A saved category being renamed: a box with its name, Save and Cancel.
// Enter saves; Esc cancels (without closing the sheet).
function RenameRow({ id, name, categories }: { id: string; name: string; categories: CategoriesState }) {
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  return (
    <li className="py-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) categories.rename(id, value);
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault(); // Esc here cancels the rename, not the whole sheet
              e.stopPropagation();
              categories.stopRenaming();
            }
          }}
          aria-label={`New name for ${name}`}
          maxLength={40}
          className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-2"
        />
        <button
          type="submit"
          disabled={categories.busy || !value.trim()}
          className="rounded-xl bg-accent px-3 py-2 text-[0.9rem] font-bold text-accent-ink disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={categories.stopRenaming}
          className="rounded-xl border border-line px-3 py-2 text-[0.9rem] font-bold text-muted"
        >
          Cancel
        </button>
      </form>
    </li>
  );
}
