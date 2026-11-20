"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { deleteForever, emptyRecentlyDeleted, getRecentlyDeleted, restoreTask } from "@/app/task-actions";
import type { BinItem } from "@/lib/tasks";

// What the Settings sheet needs to show an "are you sure?" box for us. The
// box itself is drawn by the sheet, outside its <dialog> (see settings-menu).
export type ConfirmRequest = { title: string; body: string; confirmLabel: string; onConfirm: () => void };

// Settings → Recently deleted: tasks you deleted in the last 30 days, each
// with Restore and Delete forever, and Empty bin at the bottom.
export function RecentlyDeleted({ askConfirm }: { askConfirm: (request: ConfirmRequest) => void }) {
  const [items, setItems] = useState<BinItem[] | null>(null); // null = still loading
  const [loadError, setLoadError] = useState<string | null>(null);
  // The result of the last button: "… is back" or what went wrong.
  const [note, setNote] = useState<{ text: string; isError: boolean } | null>(null);
  // One button at a time, so taps can't cross over.
  const [busy, startBusy] = useTransition();

  const load = useCallback(async () => {
    const result = await getRecentlyDeleted();
    setLoadError(result.error);
    if (!result.error) setItems(result.items ?? []);
  }, []);

  useEffect(() => {
    let current = true;
    getRecentlyDeleted().then((result) => {
      if (!current) return; // the sheet was closed meanwhile
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

  function askEmptyBin(count: number) {
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

  return (
    <section aria-labelledby="bin-heading" className="mt-3.5 rounded-[14px] border border-line bg-surface p-4">
      <h3 id="bin-heading" className="font-mono text-[0.74rem] font-medium tracking-[0.08em] text-muted uppercase">
        Recently deleted
      </h3>

      {note && (
        <p
          role={note.isError ? "alert" : "status"}
          className={`mt-2 text-[0.9rem] ${note.isError ? "font-bold text-high" : "text-ink"}`}
        >
          {note.text}
        </p>
      )}

      {loadError ? (
        <p role="alert" className="mt-2 text-[0.9rem] font-bold text-high">
          {loadError}
        </p>
      ) : items === null ? (
        <p className="mt-2 text-[0.9rem] text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-[0.9rem] text-muted">Nothing here. Tasks you delete stay here for 30 days.</p>
      ) : (
        <>
          <ul className="mt-2 divide-y divide-line">
            {items.map((item) => (
              <li key={item.id} className="py-2.5">
                <p className="font-medium [overflow-wrap:anywhere]">{item.title}</p>
                <p className="text-[0.82rem] text-muted">{deletedWhen(item.deletedAt)}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => restore(item)}
                    disabled={busy}
                    className="flex-1 rounded-xl bg-accent p-2 text-[0.9rem] font-bold text-accent-ink disabled:opacity-50"
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => askDeleteForever(item)}
                    disabled={busy}
                    className="flex-1 rounded-xl border border-line bg-bg p-2 text-[0.9rem] font-bold text-high disabled:opacity-50"
                  >
                    Delete forever
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[0.82rem] text-muted">Deleted tasks are kept for 30 days, then deleted for good.</p>
          <button
            type="button"
            onClick={() => askEmptyBin(items.length)}
            disabled={busy}
            className="mt-3 w-full rounded-xl border border-line bg-bg p-3 font-bold text-high disabled:opacity-50"
          >
            Empty bin
          </button>
        </>
      )}
    </section>
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
