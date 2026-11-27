"use client";

import { useEffect, useRef, useState } from "react";
import { swipeDelete, undoSwipeDelete } from "@/app/task-actions";
import { useToast } from "./task-editor";
import { useEditMode } from "./edit-mode";

// A task row you can swipe left to reveal a red Delete button, like the
// iPhone's own apps. Swiping back right, tapping the row or tapping anywhere
// else closes it. Deleting shows "Deleted · Undo" for a few seconds.
//
// The row's text never slides left: the Delete button slides in over the
// row's right side instead, and once it's fully out the text makes room and
// wraps, so the start of a task's name always shows (no deleting the wrong
// task because "Test 1" read as "1").
//
// Telling a swipe from a scroll or a tap: nothing happens until your finger
// (or mouse) has moved a little. Mostly sideways → it's a swipe; mostly up or
// down → the page scrolls as normal and the row ignores it. After a swipe,
// the tap that ends it is swallowed, so it can't open or tick the task.
//
// Edit mode (see edit-mode.tsx): the tick box folds away and a select circle
// takes the Delete button's place. Tapping anywhere on the row selects it;
// its tick box and title can't be tapped, and it can't be swiped.

const DELETE_WIDTH = 88; // px: the Delete button's width when fully out
const DECIDE_AFTER = 8; // px of movement before deciding swipe vs scroll

type Target = { taskId: string } | { completionId: string };

export function SwipeRow({
  target,
  label,
  className,
  rowId,
  children,
}: {
  target: Target; // a whole task, or one tick of a repeating task
  label: string; // the task's title, read out by screen readers in edit mode
  rowId?: string; // marks the row for the glow after adding a task (added-glow.ts)
  className: string; // the row's own look (padding, overdue colour)
  children: React.ReactNode;
}) {
  const toast = useToast();
  const edit = useEditMode();
  const editing = edit?.editing ?? false;
  const key = "taskId" in target ? `task:${target.taskId}` : `tick:${target.completionId}`;
  const selected = edit?.selected.has(key) ?? false;
  const register = edit?.register;
  const [offset, setOffset] = useState(0); // 0 = closed, -DELETE_WIDTH = open
  const [dragging, setDragging] = useState(false);
  const [gone, setGone] = useState(false); // hidden straight away while it's deleted
  const rowRef = useRef<HTMLLIElement>(null);
  const gesture = useRef({ x: 0, y: 0, from: 0, mode: "none" as "none" | "undecided" | "swipe" | "scroll" });
  const offsetRef = useRef(0);
  const swipedRef = useRef(false); // a swipe just ended: swallow the click that follows
  const open = offset !== 0 && !dragging;

  function move(to: number) {
    offsetRef.current = to;
    setOffset(to);
  }

  // Tapping anywhere outside the row closes it.
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) move(0);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);

  // Tells edit mode this row is on the screen (and when it goes away).
  useEffect(() => register?.(key), [register, key]);

  // Entering edit mode closes a half-open swipe, so the row is closed again
  // when edit mode ends. (State is reset while rendering, the refs after.)
  const [wasEditing, setWasEditing] = useState(editing);
  if (editing !== wasEditing) {
    setWasEditing(editing);
    if (editing) {
      setDragging(false);
      setOffset(0);
    }
  }
  useEffect(() => {
    if (!editing) return;
    gesture.current.mode = "none";
    offsetRef.current = 0;
  }, [editing]);

  function onPointerDown(e: React.PointerEvent) {
    if (editing) return; // no swiping in edit mode
    if (e.button !== 0) return; // left mouse button or a finger only
    swipedRef.current = false;
    gesture.current = { x: e.clientX, y: e.clientY, from: offsetRef.current, mode: "undecided" };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (g.mode === "none" || g.mode === "scroll") return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.mode === "undecided") {
      if (Math.abs(dx) < DECIDE_AFTER && Math.abs(dy) < DECIDE_AFTER) return;
      if (Math.abs(dy) >= Math.abs(dx)) {
        g.mode = "scroll"; // up/down: leave it to the page
        return;
      }
      g.mode = "swipe";
      swipedRef.current = true;
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId); // keep following even off the row
    }
    e.preventDefault(); // no text selection while dragging with a mouse
    // Follows your finger; a little stretch past the button, never to the right.
    move(Math.min(0, Math.max(-DELETE_WIDTH * 1.25, g.from + dx)));
  }

  function onPointerEnd() {
    const g = gesture.current;
    if (g.mode === "swipe") {
      setDragging(false);
      // Past halfway: stays open. Otherwise it springs back.
      move(offsetRef.current < -DELETE_WIDTH / 2 ? -DELETE_WIDTH : 0);
    }
    g.mode = "none";
  }

  // Runs before the row's own buttons (tick box, open task) see the click.
  function onClickCapture(e: React.MouseEvent) {
    if (swipedRef.current || offsetRef.current !== 0) {
      e.preventDefault();
      e.stopPropagation();
      if (!swipedRef.current) move(0); // tapping an open row closes it
      swipedRef.current = false;
    }
  }

  async function remove() {
    setGone(true);
    const result = await swipeDelete(target);
    if (result.error || !result.value) {
      setGone(false);
      move(0);
      toast(result.error ?? "Couldn't delete. Try again.");
      return;
    }
    const copy = result.value;
    // The row is already gone from the list (the page refreshed). Undo puts
    // the copy back and the page refreshes again to show it.
    toast("Deleted", {
      label: "Undo",
      onClick: async () => {
        const undo = await undoSwipeDelete(copy);
        if (undo.error) toast(undo.error);
      },
    });
  }

  // Edit mode: a tap anywhere on the row selects or unselects it. Caught on
  // the way down, so the tick box and the title never see it.
  function onEditClickCapture(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    edit?.toggle(key);
  }

  function onEditKeyDown(e: React.KeyboardEvent) {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault(); // Space would scroll the page; Enter would add a task
    edit?.toggle(key);
  }

  if (gone) return null;

  const reveal = -offset; // how much of the Delete button shows (px)
  const roomOnRight = editing || open; // the button or circle is fully showing

  return (
    <li
      ref={rowRef}
      // Keyboard focus in edit mode: a 2px ring drawn inside the row, on top
      // of everything in it (the row clips the browser's own outline down to a
      // thin line along the top). Only for Tab focus, not clicks.
      className="relative overflow-hidden border-t border-line outline-none first:border-t-0 focus-visible:after:pointer-events-none focus-visible:after:absolute focus-visible:after:inset-[3px] focus-visible:after:z-[2] focus-visible:after:rounded-[10px] focus-visible:after:shadow-[inset_0_0_0_2px_var(--accent)]"
      {...(editing && {
        role: "checkbox",
        "aria-checked": selected,
        "aria-label": label,
        tabIndex: 0,
        onClickCapture: onEditClickCapture,
        onKeyDown: onEditKeyDown,
      })}
    >
      <div
        // In edit mode the tick box and title are out of reach: no tapping,
        // no Tab, not read out separately (the row itself is the checkbox).
        inert={editing}
        // The tick box folds away in edit mode (see TaskRow in task-list.tsx).
        data-editing={editing}
        // The glow goes on this part (the text), so it stays under the red
        // Delete button, which sits on top of it.
        data-task-row={rowId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
        // pan-y: up/down still scrolls the page; sideways comes to us.
        className={`group/row relative flex touch-pan-y items-start gap-3 bg-surface ${
          dragging || editing ? "select-none" : ""
        } ${className}`}
        style={{
          // Set here so it beats the row's own colour (e.g. an overdue row's).
          ...(selected && { backgroundColor: "var(--accent-soft)" }),
          // The text never moves left, so a name's start always shows. When
          // the Delete button or select circle is fully showing, the text makes
          // room for it on the right and wraps onto more lines instead.
          ...(roomOnRight && { paddingRight: `calc(${DELETE_WIDTH}px + 0.875rem)` }),
          transition: "padding-right 0.2s ease-out, background-color 0.2s",
        }}
      >
        {children}
      </div>
      {/* On top of the row's right side; slides in from the right edge. */}
      {editing ? (
        <span
          aria-hidden
          className="absolute inset-y-0 right-0 z-[1] flex items-center justify-center"
          style={{ width: DELETE_WIDTH }}
        >
          <span
            className={`grid size-[26px] place-items-center rounded-full border-2 text-[0.9rem] font-bold ${
              selected ? "border-accent bg-accent text-accent-ink" : "border-muted bg-surface"
            }`}
          >
            {selected ? "✓" : ""}
          </span>
        </span>
      ) : (
        <button
          type="button"
          onClick={remove}
          tabIndex={open ? 0 : -1}
          aria-hidden={!open}
          className="absolute inset-y-0 right-0 z-[1] flex items-center justify-center overflow-hidden bg-high font-bold whitespace-nowrap text-white"
          style={{ width: reveal, transition: dragging ? "none" : "width 0.2s ease-out" }}
        >
          Delete
        </button>
      )}
    </li>
  );
}
