"use client";

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Edit mode on the Today, Upcoming and Done screens: tap Edit, then tap rows
// to select several tasks (and later delete them together, in step b).
//
// While editing, every row slides over like a swipe and shows a select circle
// where its Delete button would be; tapping a row selects or unselects it
// instead of opening or ticking it. Swiping and the Add task button are off.
// Leaving edit mode (Done, or Esc on a computer) clears the selection.
//
// A row's key is "task:<id>" for a task, or "tick:<id>" for one entry of a
// repeating task under "Finished today" (the same two things swipe deletes).

type EditMode = {
  editing: boolean;
  selected: ReadonlySet<string>;
  onScreen: ReadonlySet<string>; // every row showing now (for Select all)
  start: () => void;
  stop: () => void;
  toggle: (key: string) => void;
  selectAll: () => void;
  selectNone: () => void;
  // Each row says it's on the screen; a row that goes away (the list
  // refreshed and it's gone) is dropped from the selection.
  register: (key: string) => () => void;
};

const EditModeContext = createContext<EditMode | null>(null);

// Null on screens without edit mode (Calendar, Chat): rows behave as usual.
export function useEditMode(): EditMode | null {
  return use(EditModeContext);
}

export function EditModeProvider({ children }: { children: React.ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const rowCounts = useRef(new Map<string, number>()); // key → how many rows show it
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(new Set());

  const start = useCallback(() => setEditing(true), []);
  const stop = useCallback(() => {
    setEditing(false);
    setSelected(new Set());
  }, []);

  const toggle = useCallback((key: string) => {
    setSelected((before) => {
      const next = new Set(before);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => setSelected(new Set(rowCounts.current.keys())), []);
  const selectNone = useCallback(() => setSelected(new Set()), []);

  const register = useCallback((key: string) => {
    const before = rowCounts.current.get(key) ?? 0;
    rowCounts.current.set(key, before + 1);
    if (before === 0) setOnScreen(new Set(rowCounts.current.keys()));
    return () => {
      const left = (rowCounts.current.get(key) ?? 1) - 1;
      if (left > 0) {
        rowCounts.current.set(key, left);
        return;
      }
      rowCounts.current.delete(key);
      setOnScreen(new Set(rowCounts.current.keys()));
      setSelected((before) => {
        if (!before.has(key)) return before;
        const next = new Set(before);
        next.delete(key);
        return next;
      });
    };
  }, []);

  // Esc leaves edit mode on a computer (unless a pop-up is open: Esc is its).
  useEffect(() => {
    if (!editing) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("dialog[open]")) return;
      stop();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editing, stop]);

  const value = useMemo(
    () => ({ editing, selected, onScreen, start, stop, toggle, selectAll, selectNone, register }),
    [editing, selected, onScreen, start, stop, toggle, selectAll, selectNone, register],
  );
  return <EditModeContext value={value}>{children}</EditModeContext>;
}

// "Edit" / "Done", at the right of the category chips.
export function EditButton() {
  const edit = useEditMode();
  if (!edit) return null;
  return (
    <button
      type="button"
      onClick={edit.editing ? edit.stop : edit.start}
      aria-pressed={edit.editing}
      className={`flex-none rounded-full px-3 py-[5px] text-[0.88rem] font-bold ${
        edit.editing ? "bg-accent text-accent-ink" : "text-accent"
      }`}
    >
      {edit.editing ? "Done" : "Edit"}
    </button>
  );
}
