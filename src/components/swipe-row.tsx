"use client";

import { useEffect, useRef, useState } from "react";
import { swipeDelete, undoSwipeDelete } from "@/app/task-actions";
import { useToast } from "./task-editor";

// A task row you can swipe left to reveal a red Delete button, like the
// iPhone's own apps. Swiping back right, tapping the row or tapping anywhere
// else closes it. Deleting shows "Deleted · Undo" for a few seconds.
//
// Telling a swipe from a scroll or a tap: nothing happens until your finger
// (or mouse) has moved a little. Mostly sideways → it's a swipe; mostly up or
// down → the page scrolls as normal and the row ignores it. After a swipe,
// the tap that ends it is swallowed, so it can't open or tick the task.

const DELETE_WIDTH = 88; // px: how far the row slides to show the button
const DECIDE_AFTER = 8; // px of movement before deciding swipe vs scroll

type Target = { taskId: string } | { completionId: string };

export function SwipeRow({
  target,
  className,
  children,
}: {
  target: Target; // a whole task, or one tick of a repeating task
  className: string; // the row's own look (padding, overdue colour)
  children: React.ReactNode;
}) {
  const toast = useToast();
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

  function onPointerDown(e: React.PointerEvent) {
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

  if (gone) return null;

  return (
    <li ref={rowRef} className="relative overflow-hidden border-t border-line first:border-t-0">
      {/* Behind the row; shows as the row slides left. */}
      <button
        type="button"
        onClick={remove}
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        className="absolute inset-y-0 right-0 flex items-center justify-center bg-high font-bold text-white"
        style={{ width: Math.max(DELETE_WIDTH, -offset) }}
      >
        Delete
      </button>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
        // pan-y: up/down still scrolls the page; sideways comes to us.
        className={`relative flex touch-pan-y items-start gap-3 bg-surface ${dragging ? "select-none" : ""} ${className}`}
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? "none" : "transform 0.2s ease-out",
        }}
      >
        {children}
      </div>
    </li>
  );
}
