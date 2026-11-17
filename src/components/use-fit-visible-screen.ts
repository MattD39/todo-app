"use client";

import { useEffect, type RefObject } from "react";

// On iPhone the on-screen keyboard slides over the bottom of the page without
// making the page any smaller, so a bottom sheet ends up hidden behind it.
// This keeps an element (the task editor's <dialog>) sized to the part of the
// screen you can actually see, so the sheet sits just above the keyboard.
export function useFitVisibleScreen(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const view = window.visualViewport;
    const el = ref.current;
    if (!view || !el) return;

    const fit = () => {
      // Pinch-zoomed in: leave the normal full-screen size alone.
      if (Math.abs(view.scale - 1) > 0.01) {
        el.style.height = "";
        el.style.top = "";
        return;
      }
      el.style.height = `${view.height}px`;
      el.style.top = `${view.offsetTop}px`;
      // The sheet just got shorter: keep the box you're typing in on screen.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && el.contains(focused)) {
        focused.scrollIntoView({ block: "nearest" });
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
    };
  }, [ref]);
}
