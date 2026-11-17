"use client";

import { useEffect, useRef } from "react";

// A small "Are you sure?" pop-up in the app's own style (the browser's
// built-in confirm() box looks out of place, especially on iPhone).
// Escape, Cancel, or a tap on the dimmed area all count as "no".
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      onClose={onCancel}
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      className="m-auto w-[min(360px,calc(100%-32px))] rounded-[18px] bg-bg p-0 text-ink backdrop:bg-[rgba(10,16,12,.45)]"
    >
      <div className="sheet-in p-5">
        <h2 id="confirm-title" className="font-display text-[1.15rem] font-bold">
          {title}
        </h2>
        <div id="confirm-body" className="mt-1.5 text-[0.95rem] text-muted">
          {children}
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-line bg-surface p-3 font-bold text-ink"
          >
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className="rounded-xl bg-accent p-3 font-bold text-accent-ink">
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
