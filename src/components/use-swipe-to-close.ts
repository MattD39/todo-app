import { useEffect, useRef, type RefObject } from "react";

// Swipe down to close a bottom sheet, like iPhone sheets: the sheet follows
// your finger, and closes if you pull far enough (or flick), otherwise it
// springs back. Touch screens only: mouse and trackpad are left alone.
//
// So scrolling doesn't close a sheet by accident, a drag only starts:
//   - from the handle area (the grab bar and title row, marked with
//     data-sheet-handle), at any time, or
//   - anywhere else, only when the content is scrolled right to the top and
//     the finger moves DOWN. Moving up scrolls the content as usual.
// Not from inside a multi-line text box (Notes), which scrolls on its own.
//
// Why touch events, not pointer events: to stop the page scrolling while the
// sheet is dragged, the very first finger movement must be cancelled
// (preventDefault). Safari only allows that on touchmove listeners added with
// { passive: false }; once it starts scrolling it's too late.
//
// panelRef: the part that slides. scrollRef: the part that scrolls (often
// the panel itself). onClose: exactly what the sheet's Close button does.
// screen: anything that changes when a different panel is shown in the same
// sheet (Settings ↔ Recently deleted), so the listeners move to the new one.
export function useSwipeToClose(
  panelRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  screen?: string,
) {
  // The latest onClose, without re-adding the listeners every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    let mode: "off" | "maybe" | "drag" = "off";
    let startX = 0;
    let startY = 0;
    let offset = 0; // how far down the sheet is pulled, in px
    let speed = 0; // px per ms, downward, from the last finger movements
    let lastY = 0;
    let lastTime = 0;
    let closing = false;

    const setOffset = (px: number, animate: boolean) => {
      panel.style.transition = animate ? "transform 0.22s ease-out" : "none";
      panel.style.transform = px > 0 ? `translateY(${px}px)` : "";
    };

    function onTouchStart(e: TouchEvent) {
      if (closing || e.touches.length !== 1 || !(e.target instanceof Element)) {
        mode = "off";
        return;
      }
      const fromHandle = !!e.target.closest("[data-sheet-handle]");
      const atTop = (scrollRef.current?.scrollTop ?? 0) <= 0;
      const inTextArea = !!e.target.closest("textarea");
      mode = fromHandle || (atTop && !inTextArea) ? "maybe" : "off";
      startX = touchX(e);
      startY = lastY = e.touches[0].clientY;
      lastTime = e.timeStamp;
      offset = 0;
      speed = 0;
    }

    function onTouchMove(e: TouchEvent) {
      if (mode === "off") return;
      const y = e.touches[0].clientY;
      if (mode === "maybe") {
        const dy = y - startY;
        const dx = touchX(e) - startX;
        // Decide on the first movement: down (more down than sideways) drags
        // the sheet; anything else is left to scroll as normal.
        if (dy > 0 && dy >= Math.abs(dx)) mode = "drag";
        else {
          mode = "off";
          return;
        }
      }
      e.preventDefault(); // the sheet moves, not the page
      offset = Math.max(0, y - startY);
      const dt = e.timeStamp - lastTime;
      if (dt > 0) speed = (y - lastY) / dt;
      lastY = y;
      lastTime = e.timeStamp;
      setOffset(offset, false);
    }

    function onTouchEnd() {
      if (mode !== "drag") {
        mode = "off";
        return;
      }
      mode = "off";
      // Far enough (a quarter of the sheet, at least 120px), or a quick flick down.
      const farEnough = offset > Math.max(120, panel!.offsetHeight * 0.25);
      const flicked = speed > 0.6 && offset > 30;
      if (farEnough || flicked) {
        closing = true;
        setOffset(panel!.offsetHeight, true);
        // After the slide-out, close exactly as the Close button does.
        setTimeout(() => onCloseRef.current(), 200);
      } else {
        setOffset(0, true);
      }
      // A drag that started on a button (e.g. Close or Add) must not also
      // count as a tap on it when the finger lifts.
      if (offset > 8) swallowNextClick(panel!);
    }

    panel.addEventListener("touchstart", onTouchStart, { passive: true });
    panel.addEventListener("touchmove", onTouchMove, { passive: false });
    panel.addEventListener("touchend", onTouchEnd);
    panel.addEventListener("touchcancel", onTouchEnd);
    return () => {
      panel.removeEventListener("touchstart", onTouchStart);
      panel.removeEventListener("touchmove", onTouchMove);
      panel.removeEventListener("touchend", onTouchEnd);
      panel.removeEventListener("touchcancel", onTouchEnd);
      panel.style.transform = "";
      panel.style.transition = "";
    };
  }, [panelRef, scrollRef, screen]);
}

function touchX(e: TouchEvent) {
  return e.touches[0].clientX;
}

function swallowNextClick(el: HTMLElement) {
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  el.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => el.removeEventListener("click", swallow, { capture: true }), 400);
}
