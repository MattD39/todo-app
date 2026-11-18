import { useRef, type MouseEvent, type PointerEvent } from "react";

// Lets a tap or click on a <dialog>'s dimmed area close it, but only when the
// press both starts AND ends on the dimmed area.
//
// Why: the browser reports a click on whatever the press *ended* on. So
// pressing inside the sheet (say, dragging to select text in Notes) and
// letting go outside it looked like a click on the dimmed area, and the sheet
// closed. Remembering where the press started fixes that.
//
// Spread the result onto the <dialog>: <dialog {...backdropClose}>.
export function useBackdropClose(onClose: () => void) {
  const pressStartedOutside = useRef(false);
  return {
    onPointerDown(e: PointerEvent<HTMLDialogElement>) {
      pressStartedOutside.current = e.target === e.currentTarget;
    },
    onClick(e: MouseEvent<HTMLDialogElement>) {
      const startedOutside = pressStartedOutside.current;
      pressStartedOutside.current = false;
      if (startedOutside && e.target === e.currentTarget) onClose();
    },
  };
}
