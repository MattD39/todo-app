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

    const fit = () => {
      const zoomed = Math.abs(view.scale - 1) > 0.01;
      // Over 100px hidden means a keyboard (not just a toolbar).
      const keyboard = !zoomed && window.innerHeight - view.height > 100;
      if (keyboard) {
        el.style.height = `${view.height}px`;
        el.style.top = `${view.offsetTop}px`;
        root.dataset.keyboard = "open";
      } else {
        // Keyboard down (or pinch-zoomed): the normal full-screen size.
        el.style.height = "";
        el.style.top = "";
        delete root.dataset.keyboard;
      }
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
