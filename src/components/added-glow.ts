// After you add a task that shows on the screen you're on, this finds its
// row, scrolls it into view if it's off screen, and gives it a soft green
// glow that fades (the glow itself is in globals.css: [data-added-glow]).
//
// The steps, in order:
//   1. Wait for the row: the list reloads with the new task a moment after
//      saving. Give up after about 1.5 seconds and call onMissing (which
//      shows a plain "Added").
//   2. Wait for the sheet and the iPhone keyboard to finish closing, so the
//      screen has its full height back before we measure where the row is.
//   3. If the row is hidden under the sticky header or the tab bar, or below
//      the screen, scroll so it sits in the middle of the free space.
//      With "reduce motion" on, it jumps there instead of gliding.
//   4. Glow.
//
// Rows are marked with data-task-row="<task id>" (see task-list.tsx). For a
// row you can swipe, the mark is on the part that holds the text, so the glow
// stays under the red Delete button instead of painting it.

const WAIT_FOR_ROW_MS = 1500;
const WAIT_FOR_KEYBOARD_MS = 1200; // go ahead anyway after this
const STILL_FOR_MS = 300; // the visible height hasn't changed for this long = keyboard done

// Only one at a time: adding another task straight away cancels the last one.
let current = 0;

export function showAddedTask(taskId: string, onMissing: () => void) {
  const run = ++current;
  const started = performance.now();
  let row: HTMLElement | null = null;
  let foundAt = 0;
  let lastHeight = -1;
  let lastChange = 0;

  const tick = (now: number) => {
    if (run !== current) return; // a newer add took over

    // 1. The row.
    if (!row) {
      row = findRow(taskId);
      if (!row) {
        if (now - started > WAIT_FOR_ROW_MS) onMissing();
        else requestAnimationFrame(tick);
        return;
      }
      foundAt = now;
    }

    // 2. The sheet and the keyboard. The visible height (visualViewport)
    // grows back as the iPhone keyboard slides away; once it stops changing
    // and no text box has the cursor, it's done.
    const height = window.visualViewport?.height ?? window.innerHeight;
    if (height !== lastHeight) {
      lastHeight = height;
      lastChange = now;
    }
    const settled =
      !document.querySelector("dialog[open]") && !typingSomewhere() && now - lastChange >= STILL_FOR_MS;
    if (!settled && now - foundAt < WAIT_FOR_KEYBOARD_MS) {
      requestAnimationFrame(tick);
      return;
    }

    // The list may have redrawn while we waited: use the row that's there now.
    const target = row.isConnected ? row : findRow(taskId);
    if (!target) return onMissing();
    scrollIntoFreeSpace(target);
    glow(target);
  };
  requestAnimationFrame(tick);
}

// The row on the screen you're looking at. Screens you've left can stay in
// the page, hidden, so skip any copy that isn't showing.
function findRow(taskId: string): HTMLElement | null {
  return showing(document.querySelectorAll<HTMLElement>(`[data-task-row="${CSS.escape(taskId)}"]`));
}

// The first one that's actually showing (a hidden one has no size).
function showing(els: NodeListOf<HTMLElement>): HTMLElement | null {
  return [...els].find((el) => el.getClientRects().length > 0) ?? null;
}

function typingSomewhere(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && el.matches("input, textarea, select, [contenteditable]");
}

function scrollIntoFreeSpace(row: HTMLElement) {
  const view = window.visualViewport;
  const viewTop = view?.offsetTop ?? 0;
  const viewBottom = viewTop + (view?.height ?? window.innerHeight);
  // The free space: below the sticky header, above the tab bar.
  // (The ones on this screen: screens you've left can stay in the page, hidden.)
  const header = row.closest("main")?.querySelector("header")?.getBoundingClientRect();
  const tabBar = showing(document.querySelectorAll<HTMLElement>("[data-tab-bar]"))?.getBoundingClientRect();
  const top = Math.max(viewTop, header?.bottom ?? viewTop);
  const bottom = Math.min(viewBottom, tabBar?.top ?? viewBottom);

  const rect = row.getBoundingClientRect();
  if (rect.top >= top && rect.bottom <= bottom) return; // already in view

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollBy({
    top: (rect.top + rect.bottom) / 2 - (top + bottom) / 2,
    behavior: reduceMotion ? "instant" : "smooth",
  });
}

function glow(row: HTMLElement) {
  // Restart it if this row is already glowing.
  row.removeAttribute("data-added-glow");
  void row.offsetWidth; // makes the browser notice it was removed
  row.setAttribute("data-added-glow", "");
  const done = (e: AnimationEvent) => {
    if (e.target !== row) return; // something inside the row finished its own animation
    row.removeAttribute("data-added-glow");
    row.removeEventListener("animationend", done);
  };
  row.addEventListener("animationend", done);
}
