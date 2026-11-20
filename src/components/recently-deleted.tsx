"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { deleteForever, emptyRecentlyDeleted, getRecentlyDeleted, restoreAll, restoreTask } from "@/app/task-actions";
import type { BinItem } from "@/lib/tasks";

// What the Settings sheet needs to show an "are you sure?" box for us. The
// box itself is drawn by the sheet, outside its <dialog> (see settings-menu).
export type ConfirmRequest = { title: string; body: string; confirmLabel: string; onConfirm: () => void };

// Settings → Recently deleted: tasks you deleted in the last 30 days. Settings
// shows one row with how many there are; tapping it opens the full list (a
// second screen inside the same sheet), with Restore and Delete forever on
// each task and Restore all / Empty bin in a bar that stays at the bottom.

// The list and what its buttons do. Lives in the Settings sheet, so the list
// stays loaded while you move between Settings and Recently deleted.
export function useRecentlyDeleted(askConfirm: (request: ConfirmRequest) => void) {
  const [items, setItems] = useState<BinItem[] | null>(null); // null = still loading
  const [loadError, setLoadError] = useState<string | null>(null);
  // The result of the last button: "… is back" or what went wrong.
  const [note, setNote] = useState<{ text: string; isError: boolean } | null>(null);
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
      if (result.error) {
        setNote({ text: result.error, isError: true });
        await load(); // e.g. it was restored or deleted on another device
      } else {
        remove(item.id);
        setNote({ text: `“${result.value ?? item.title}” is back on your lists.`, isError: false });
      }
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
          text: `${tasksWord(restored)} back on your lists. ${tasksWord(failed)} couldn't be restored: try again.`,
          isError: true,
        });
      } else setNote({ text: `${tasksWord(restored)} back on your lists.`, isError: false });
      await load(); // shows exactly what's still in the bin
    });
  }

  function askDeleteForever(item: BinItem) {
    askConfirm({
      title: "Delete forever?",
      body: `“${item.title}” will be gone for good. This can't be undone.`,
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
            setNote({ text: `“${item.title}” was deleted for good.`, isError: false });
          }
        }),
    });
  }

  function askEmptyBin() {
    const count = items?.length ?? 0;
    askConfirm({
      title: "Empty Recently deleted?",
      body: `${count === 1 ? "The 1 task" : `All ${count} tasks`} in Recently deleted will be gone for good. This can't be undone.`,
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

function tasksWord(n: number): string {
  return n === 1 ? "1 task is" : `${n} tasks are`;
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
      <span className="text-muted" aria-label={count ? `${count} tasks` : undefined}>
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
export function RecentlyDeletedScreen({ bin, onBack }: { bin: RecentlyDeletedState; onBack: () => void }) {
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);

  const { items } = bin;
  const empty = !items || items.length === 0;

  return (
    <>
      <div className="flex-none px-[max(16px,env(safe-area-inset-left,0px))] pt-2.5 pb-2">
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

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[max(16px,env(safe-area-inset-left,0px))] pb-3">
        {bin.note && (
          <p
            role={bin.note.isError ? "alert" : "status"}
            className={`mb-2 text-[0.9rem] ${bin.note.isError ? "font-bold text-high" : "text-ink"}`}
          >
            {bin.note.text}
          </p>
        )}

        {bin.loadError ? (
          <p role="alert" className="text-[0.9rem] font-bold text-high">
            {bin.loadError}
          </p>
        ) : items === null ? (
          <p className="text-[0.9rem] text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-[0.9rem] text-muted">Nothing here. Tasks you delete stay here for 30 days.</p>
        ) : (
          <>
            <ul className="divide-y divide-line rounded-[14px] border border-line bg-surface px-4">
              {items.map((item) => (
                <li key={item.id} className="py-3">
                  <p className="font-medium [overflow-wrap:anywhere]">{item.title}</p>
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
            <p className="mt-2 text-[0.82rem] text-muted">Deleted tasks are kept for 30 days, then deleted for good.</p>
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
