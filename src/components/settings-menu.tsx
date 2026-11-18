"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { signOut } from "@/app/login/actions";
import { ConfirmDialog } from "./confirm-dialog";
import { useBackdropClose } from "./use-backdrop-close";

// The gear button in each screen's header, and the settings sheet it opens.
// For now the sheet holds your account and Sign out; more settings can join later.
export function SettingsButton({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Settings"
        aria-haspopup="dialog"
        className="grid size-9 flex-none place-items-center rounded-[10px] bg-sunk text-muted"
      >
        <GearIcon />
      </button>
      {open && <SettingsSheet email={email} onClose={() => setOpen(false)} />}
    </>
  );
}

// Same size as the gear, so the header doesn't shift while a screen loads.
export function SettingsButtonPlaceholder() {
  return <span aria-hidden className="size-9 flex-none" />;
}

function SettingsSheet({ email, onClose }: { email: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const signOutForm = useRef<HTMLFormElement>(null);
  const [confirming, setConfirming] = useState(false);
  const backdropClose = useBackdropClose(onClose);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  return (
    <>
      <dialog
        ref={dialogRef}
        aria-labelledby="settings-title"
        onClose={onClose}
        // A tap on the dimmed area (outside the panel) closes it.
        {...backdropClose}
        className="m-0 h-dvh max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-[rgba(10,16,12,.45)]"
      >
        <div className="sheet-in absolute inset-x-0 bottom-0 mx-auto max-h-[92%] w-full max-w-[640px] overflow-y-auto overscroll-contain rounded-t-[18px] bg-bg px-[max(16px,env(safe-area-inset-left,0px))] pt-2.5 pb-[calc(20px+env(safe-area-inset-bottom,0px))] text-ink">
          <div className="mx-auto mb-2.5 h-1 w-10 rounded bg-line" aria-hidden />
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 id="settings-title" className="font-display text-[1.2rem] font-bold">
              Settings
            </h2>
            <button type="button" onClick={onClose} className="p-1.5 text-muted">
              Close
            </button>
          </div>

          <section aria-labelledby="account-heading" className="rounded-[14px] border border-line bg-surface p-4">
            <h3
              id="account-heading"
              className="font-mono text-[0.74rem] font-medium tracking-[0.08em] text-muted uppercase"
            >
              Account
            </h3>
            <p className="mt-1.5 text-[0.95rem]">
              Signed in as <b className="[overflow-wrap:anywhere]">{email}</b>
            </p>
            {/* The same sign-out form as before; the button asks "are you sure?"
                first, and a yes submits it. The server then sends you to /login. */}
            <form ref={signOutForm} action={signOut}>
              <SignOutButton onClick={() => setConfirming(true)} />
            </form>
          </section>
        </div>
      </dialog>

      {/* Kept outside the sheet's <dialog>: React passes a nested dialog's
          "close" up to the outer one, which would shut the whole sheet. */}
      {confirming && (
        <ConfirmDialog
          title="Sign out?"
          confirmLabel="Sign out"
          onConfirm={() => {
            setConfirming(false);
            signOutForm.current?.requestSubmit();
          }}
          onCancel={() => setConfirming(false)}
        >
          You&apos;ll need your email and password to sign back in.
        </ConfirmDialog>
      )}
    </>
  );
}

// Inside the form so it can tell when the form is busy sending.
function SignOutButton({ onClick }: { onClick: () => void }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="mt-3.5 w-full rounded-xl border border-line bg-bg p-3 font-bold text-high disabled:opacity-50"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-5"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
