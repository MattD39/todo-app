"use client";

import { useEffect, useRef } from "react";

// The Chat screen's outer box. Unlike the other tabs, Chat doesn't scroll the
// whole page: it's a fixed column (header at the top, the messages scrolling
// in the middle, the message bar at the bottom).
//
// Why: on iPhone the keyboard slides over the page without making it smaller,
// so the phone pushes the whole page up to show the message box, and the
// header and first messages go off the top. Instead, this keeps the column
// sized to the part of the screen you can see, so the keyboard just makes the
// messages area shorter. While the keyboard is up, the tab bar is hidden too
// (globals.css, using the `data-keyboard` mark set here).
export function ChatFrame({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const view = window.visualViewport;
    const el = ref.current;
    const root = document.documentElement;
    if (!view || !el) return;

    // The visible height with no keyboard: the tallest it's been since the
    // screen last changed width (turning the phone resets it). We can't
    // compare with window.innerHeight instead: on iPhone that shrinks along
    // with the keyboard, so the difference is always about 0.
    let fullHeight = 0;
    let lastWidth = 0;

    const fit = () => {
      // Pinch-zoomed in: leave the normal full-screen size alone.
      if (Math.abs(view.scale - 1) > 0.01) {
        el.style.height = "";
        el.style.top = "";
        delete root.dataset.keyboard;
        return;
      }
      if (view.width !== lastWidth) {
        lastWidth = view.width;
        fullHeight = 0;
      }
      fullHeight = Math.max(fullHeight, view.height);

      // Always match the part of the screen you can see, and follow it when
      // the iPhone shifts it to show the message box. (The task editor's
      // sheet does the same, see use-fit-visible-screen.ts.)
      el.style.height = `${view.height}px`;
      el.style.top = `${view.offsetTop}px`;

      // Over 100px shorter than usual means a keyboard (not just a toolbar).
      if (fullHeight - view.height > 100) root.dataset.keyboard = "open";
      else delete root.dataset.keyboard;
    };

    fit();
    view.addEventListener("resize", fit);
    view.addEventListener("scroll", fit);
    return () => {
      view.removeEventListener("resize", fit);
      view.removeEventListener("scroll", fit);
      el.style.height = "";
      el.style.top = "";
      delete root.dataset.keyboard;
    };
  }, []);

  return (
    <main
      ref={ref}
      className="chat-frame fixed inset-x-0 top-0 mx-auto flex h-dvh w-full max-w-[640px] flex-col px-4 pt-[env(safe-area-inset-top,0px)]"
    >
      {children}
    </main>
  );
}
