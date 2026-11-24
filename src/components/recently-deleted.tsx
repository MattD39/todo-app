"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type RefObject } from "react";
import {
  deleteForever,
  emptyRecentlyDeleted,
  getRecentlyDeleted,
  restoreAll,
  restoreEntryWithTask,
  restoreTask,
} from "@/app/task-actions";
import { formatDay } from "@/lib/dates";
import type { BinItem } from "@/lib/tasks";

// What the Settings sheet needs to show an "are you sure?" box for us. The
// box itself is drawn by the sheet, outside its <dialog> (see settings-menu).
export type ConfirmRequest = { title: string; body: string; confirmLabel: string; onConfirm: () => void };

// Settings → Recently deleted: tasks (and single entries of repeating tasks)
// you deleted in the last 30 days. Settings
// shows one row with how many there are; tapping it opens the full list (a
// second screen inside the same sheet), with Restore and Delete forever on
// each task and Restore all / Empty bin in a bar that stays at the bottom.

// The list and what its buttons do. Lives in the Settings sheet, so the list
// stays loaded while you move between Settings and Recently deleted.
export function useRecentlyDeleted(askConfirm: (request: ConfirmRequest) => void) {
  const [items, setItems] = useState<BinItem[] | null>(null); // null = still loading
  const [loadError, setLoadError] = useState<string | null>(null);
  // The result of the last button: "… is back" or what went wrong, sometimes
  // with a button of its own ("Restore both").
  const [note, setNote] = useState<{
    text: string;
    isError: boolean;
    action?: { label: string; onClick: () => void };
  } | null>(null);
  // One button at a time, so taps can't cross over.
  const [busy, startBusy] = useTransition();
  const [restoringAll, setRestoringAll] = useState(false);

  const load = useCallback(async () => {
    const result = await getRecentlyDeleted();
    setLoadError(result.error);
    if (!result.error) setItems(result.items ?? []);
  }, []);

  // Loaded when Settings opens, so the row can show how many there are.
  useEffect(() => {
    let current = true;
    getRecentlyDeleted().then((result) => {
      if (!current) return; // Settings was closed meanwhile
      setLoadError(result.error);
      if (!result.error) setItems(result.items ?? []);
    });
    return () => {
      current = false;
    };
  }, []);

  function remove(id: string) {
    setItems((list) => list?.filter((item) => item.id !== id) ?? null);
  }

  function restore(item: BinItem) {
    startBusy(async () => {
      setNote(null);
      const result = await restoreTask(item.id);
      if (result.error || !result.value) {
        setNote({ text: result.error ?? "Couldn't restore. Try again.", isError: true });
        await load(); // e.g. it was restored or deleted on another device
      } else if ("needsTask" in result.value) {
        // An entry whose task is in here too: nothing changed yet.
        const task = result.value.needsTask;
        setNote({
          text: `Restore “${task}” first.`,
          isError: true,
          action: { label: "Restore both", onClick: () => restoreBoth(item, task) },
        });
      } else {
        remove(item.id);
        const what = item.kind === "tick" ? `The tick on “${result.value.restored}”` : `“${result.value.restored}”`;
        setNote({ text: `${what} is back.`, isError: false });
      }
    });
  }

  // An entry and its task together (offered when the task is in here too).
  function restoreBoth(item: BinItem, task: string) {
    startBusy(async () => {
      setNote(null);
      const result = await restoreEntryWithTask(item.id);
      if (result.error) setNote({ text: result.error, isError: true });
      else setNote({ text: `“${result.value ?? task}” and its tick are back.`, isError: false });
      await load(); // both left the list
    });
  }

  // No "are you sure?": putting tasks back is easy to reverse (delete them again).
  function restoreEverything() {
    startBusy(async () => {
      setNote(null);
      setRestoringAll(true);
      const result = await restoreAll();
      setRestoringAll(false);
      const { restored = 0, failed = 0 } = result.value ?? {};
      if (result.error) setNote({ text: result.error, isError: true });
      else if (failed > 0) {
        setNote({
          text: `${itemsWord(restored)} back. ${itemsWord(failed)} couldn't be restored (see the list).`,
          isError: true,
        });
      } else setNote({ text: `${itemsWord(restored)} back.`, isError: false });
      await load(); // shows exactly what's still in the bin
    });
  }

  function askDeleteForever(item: BinItem) {
    askConfirm({
      title: "Delete forever?",
      body: `“${binLabel(item)}” will be gone for good. This can't be undone.`,
      confirmLabel: "Delete forever",
      onConfirm: () =>
        startBusy(async () => {
          setNote(null);
          const result = await deleteForever(item.id);
          if (result.error) {
            setNote({ text: result.error, isError: true });
            await load();
          } else {
            remove(item.id);
            setNote({ text: `“${binLabel(item)}” was deleted for good.`, isError: false });
          }
        }),
    });
  }

  function askEmptyBin() {
    const count = items?.length ?? 0;
    askConfirm({
      title: "Empty Recently deleted?",
      body: `${count === 1 ? "The 1 item" : `All ${count} items`} in Recently deleted will be gone for good. This can't be undone.`,
      confirmLabel: "Empty bin",
      onConfirm: () =>
        startBusy(async () => {
          setNote(null);
          const result = await emptyRecentlyDeleted();
          if (result.error) {
            setNote({ text: result.error, isError: true });
            await load();
          } else {
            setItems([]);
            setNote({ text: "Recently deleted is empty.", isError: false });
          }
        }),
    });
  }

  return {
    items,
    loadError,
    note,
    clearNote: () => setNote(null),
    busy,
    restoringAll,
    restore,
    restoreEverything,
    askDeleteForever,
    askEmptyBin,
  };
}

export type RecentlyDeletedState = ReturnType<typeof useRecentlyDeleted>;

function itemsWord(n: number): string {
  return n === 1 ? "1 item is" : `${n} items are`;
}

// How an item is named in the list: a task by its title, an entry as
// "Brush teeth · ticked Mon, Nov 24".
function binLabel(item: BinItem): string {
  return item.kind === "tick" ? `${item.title} · ticked ${formatDay(item.ticked)}` : item.title;
}

// The one row in Settings. `focusOnMount`: coming back from the list, so the
// keyboard focus lands back on this row instead of being lost.
export function RecentlyDeletedRow({
  bin,
  onOpen,
  focusOnMount,
}: {
  bin: RecentlyDeletedState;
  onOpen: () => void;
  focusOnMount: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);

  const count = bin.loadError ? "" : bin.items === null ? "…" : String(bin.items.length);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      className="mt-3.5 flex w-full items-center gap-2 rounded-[14px] border border-line bg-surface p-4 text-left"
    >
      <span className="flex-1 font-bold">Recently deleted</span>
      <span className="text-muted" aria-label={count ? `${count} items` : undefined}>
        {count}
      </span>
      <span aria-hidden className="text-[1.2rem] leading-none text-muted">
        ›
      </span>
    </button>
  );
}

// The full list: a header with the way back, the list (it scrolls), and the
// Restore all / Empty bin bar, which stays at the bottom however far you scroll.
export function RecentlyDeletedScreen({
  bin,
  onBack,
  scrollRef,
}: {
  bin: RecentlyDeletedState;
  onBack: () => void;
  scrollRef: RefObject<HTMLDivElement | null>; // the list, which scrolls (for swipe down to close)
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);

  const { items } = bin;
  const empty = !items || items.length === 0;

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
            Recently deleted
          </h2>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[max(16px,env(safe-area-inset-left,0px))] pb-3"
      >
        {bin.note && (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p
              role={bin.note.isError ? "alert" : "status"}
              className={`text-[0.9rem] ${bin.note.isError ? "font-bold text-high" : "text-ink"}`}
            >
              {bin.note.text}
            </p>
            {bin.note.action && (
              <button
                type="button"
                onClick={bin.note.action.onClick}
                disabled={bin.busy}
                className="rounded-xl bg-accent px-3 py-1.5 text-[0.9rem] font-bold text-accent-ink disabled:opacity-50"
              >
                {bin.note.action.label}
              </button>
            )}
          </div>
        )}

        {bin.loadError ? (
          <p role="alert" className="text-[0.9rem] font-bold text-high">
            {bin.loadError}
          </p>
        ) : items === null ? (
          <p className="text-[0.9rem] text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-[0.9rem] text-muted">Nothing here. Tasks and ticks you delete stay here for 30 days.</p>
        ) : (
          <>
            <ul className="divide-y divide-line rounded-[14px] border border-line bg-surface px-4">
              {items.map((item) => (
                <li key={item.id} className="py-3">
                  <p className="font-medium [overflow-wrap:anywhere]">{binLabel(item)}</p>
                  <p className="text-[0.82rem] text-muted">{deletedWhen(item.deletedAt)}</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => bin.restore(item)}
                      disabled={bin.busy}
                      className="flex-1 rounded-xl bg-accent p-2 text-[0.9rem] font-bold text-accent-ink disabled:opacity-50"
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => bin.askDeleteForever(item)}
                      disabled={bin.busy}
                      className="flex-1 rounded-xl border border-line bg-bg p-2 text-[0.9rem] font-bold text-high disabled:opacity-50"
                    >
                      Delete forever
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[0.82rem] text-muted">Deleted tasks and ticks are kept for 30 days, then deleted for good.</p>
          </>
        )}
      </div>

      <div className="flex flex-none gap-2 border-t border-line bg-bg px-[max(16px,env(safe-area-inset-left,0px))] pt-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))]">
        <button
          type="button"
          onClick={bin.restoreEverything}
          disabled={bin.busy || empty}
          className="flex-1 rounded-xl bg-accent p-3 font-bold text-accent-ink disabled:opacity-50"
        >
          {bin.restoringAll ? "Restoring…" : "Restore all"}
        </button>
        <button
          type="button"
          onClick={bin.askEmptyBin}
          disabled={bin.busy || empty}
          className="flex-1 rounded-xl border border-line bg-surface p-3 font-bold text-high disabled:opacity-50"
        >
          Empty bin
        </button>
      </div>
    </>
  );
}

// "Deleted today", "Deleted yesterday", "Deleted 3 days ago" (by calendar day
// on this device).
function deletedWhen(iso: string): string {
  const deleted = new Date(iso);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(deleted)) / 86_400_000);
  if (days <= 0) return "Deleted today";
  if (days === 1) return "Deleted yesterday";
  return `Deleted ${days} days ago`;
}
