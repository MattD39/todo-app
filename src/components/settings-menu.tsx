"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { signOut, signOutEverywhere } from "@/app/login/actions";
import { clearSavedChat } from "./chat-store";
import { ConfirmDialog } from "./confirm-dialog";
import { RecentlyDeletedRow, RecentlyDeletedScreen, useRecentlyDeleted, type ConfirmRequest } from "./recently-deleted";
import { CategoriesRow, CategoriesScreen, useCategories } from "./categories-settings";
import { useBackdropClose } from "./use-backdrop-close";
import { useSwipeToClose } from "./use-swipe-to-close";

// The gear button in each screen's header, and the settings sheet it opens.
// The sheet holds your account (Sign out, Sign out of all devices),
// Categories and Recently deleted.
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
  // Which "are you sure?" is open: plain Sign out, or Sign out of all devices.
  const [confirming, setConfirming] = useState<"this" | "all" | null>(null);
  const [signingOutAll, startSignOutAll] = useTransition();
  const [signOutAllError, setSignOutAllError] = useState<string | null>(null);
  // An "are you sure?" asked by Recently deleted (Delete forever, Empty bin)
  // or by Categories (Delete a category).
  const [binConfirm, setBinConfirm] = useState<ConfirmRequest | null>(null);
  const bin = useRecentlyDeleted(setBinConfirm);
  const categories = useCategories(setBinConfirm);
  // Which screen the sheet shows: Settings, Categories or Recently deleted.
  // `cameBackFrom`: returned from one, so focus goes back to its row.
  const [view, setView] = useState<"settings" | "bin" | "categories">("settings");
  const [cameBackFrom, setCameBackFrom] = useState<"bin" | "categories" | null>(null);
  const backdropClose = useBackdropClose(onClose);
  // Swipe down to close (iPhone), on any screen. On Settings the panel
  // scrolls; on the other two only the part in the middle does.
  const panelRef = useRef<HTMLDivElement>(null);
  const binScrollRef = useRef<HTMLDivElement>(null);
  const categoriesScrollRef = useRef<HTMLDivElement>(null);
  useSwipeToClose(
    panelRef,
    view === "bin" ? binScrollRef : view === "categories" ? categoriesScrollRef : panelRef,
    onClose,
    view,
  );

  function openBin() {
    bin.clearNote();
    setView("bin");
  }
  function openCategories() {
    categories.clearNote();
    categories.stopRenaming();
    setView("categories");
  }
  function backToSettings() {
    setCameBackFrom(view === "settings" ? null : view);
    setView("settings");
  }

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  return (
    <>
      <dialog
        ref={dialogRef}
        aria-labelledby="settings-title"
        onClose={onClose}
        // Escape on Recently deleted or Categories goes back to Settings first.
        onCancel={(e) => {
          if (view !== "settings") {
            e.preventDefault();
            backToSettings();
          }
        }}
        // A tap on the dimmed area (outside the panel) closes it.
        {...backdropClose}
        className="m-0 h-dvh max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-[rgba(10,16,12,.45)]"
      >
        {view === "bin" ? (
          // A fixed-height panel: header at the top, the list scrolls in the
          // middle, and the Restore all / Empty bin bar stays at the bottom.
          <div
            ref={panelRef}
            className="absolute inset-x-0 bottom-0 mx-auto flex h-[92%] w-full max-w-[640px] flex-col overflow-hidden rounded-t-[18px] bg-bg text-ink"
          >
            <RecentlyDeletedScreen bin={bin} onBack={backToSettings} onClose={onClose} scrollRef={binScrollRef} />
          </div>
        ) : view === "categories" ? (
          // Same shape: header at the top, the rest scrolls.
          <div
            ref={panelRef}
            className="absolute inset-x-0 bottom-0 mx-auto flex h-[92%] w-full max-w-[640px] flex-col overflow-hidden rounded-t-[18px] bg-bg text-ink"
          >
            <CategoriesScreen
              categories={categories}
              onBack={backToSettings}
              onClose={onClose}
              scrollRef={categoriesScrollRef}
            />
          </div>
        ) : (
          <div
            ref={panelRef}
            className="sheet-in absolute inset-x-0 bottom-0 mx-auto max-h-[92%] w-full max-w-[640px] overflow-y-auto overscroll-contain rounded-t-[18px] bg-bg px-[max(16px,env(safe-area-inset-left,0px))] pt-2.5 pb-[calc(20px+env(safe-area-inset-bottom,0px))] text-ink"
          >
            <div data-sheet-handle className="mx-auto mb-2.5 h-1 w-10 rounded bg-line" aria-hidden />
            <div data-sheet-handle className="mb-3 flex items-center justify-between gap-2">
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
                <SignOutButton onClick={() => setConfirming("this")} />
              </form>
              <button
                type="button"
                onClick={() => {
                  setSignOutAllError(null);
                  setConfirming("all");
                }}
                disabled={signingOutAll}
                className="mt-2.5 w-full rounded-xl border border-line bg-bg p-3 font-bold text-high disabled:opacity-50"
              >
                {signingOutAll ? "Signing out everywhere…" : "Sign out of all devices"}
              </button>
              {signOutAllError && (
                <p role="alert" className="mt-2 text-[0.9rem] text-high">
                  {signOutAllError}
                </p>
              )}
            </section>

            <CategoriesRow categories={categories} onOpen={openCategories} focusOnMount={cameBackFrom === "categories"} />
            <RecentlyDeletedRow bin={bin} onOpen={openBin} focusOnMount={cameBackFrom === "bin"} />
          </div>
        )}
      </dialog>

      {/* Kept outside the sheet's <dialog>: React passes a nested dialog's
          "close" up to the outer one, which would shut the whole sheet. */}
      {confirming === "this" && (
        <ConfirmDialog
          title="Sign out?"
          confirmLabel="Sign out"
          onConfirm={() => {
            setConfirming(null);
            clearSavedChat(); // the next person on this device shouldn't see it
            signOutForm.current?.requestSubmit();
          }}
          onCancel={() => setConfirming(null)}
        >
          You&apos;ll need your email and password to sign back in.
        </ConfirmDialog>
      )}
      {confirming === "all" && (
        <ConfirmDialog
          title="Sign out everywhere?"
          confirmLabel="Sign out everywhere"
          onConfirm={() => {
            setConfirming(null);
            clearSavedChat(); // as with plain Sign out
            startSignOutAll(async () => {
              // On success the server sends you to /login, so this only
              // comes back when it failed (and you're still signed in).
              const { error } = await signOutEverywhere();
              setSignOutAllError(error);
            });
          }}
          onCancel={() => setConfirming(null)}
        >
          This signs you out here and on every other device, like your phone and computer. Other devices may take up to
          an hour to be signed out. You&apos;ll also need to connect Claude to your tasks again.
        </ConfirmDialog>
      )}
      {binConfirm && (
        <ConfirmDialog
          title={binConfirm.title}
          confirmLabel={binConfirm.confirmLabel}
          onConfirm={() => {
            setBinConfirm(null);
            binConfirm.onConfirm();
          }}
          onCancel={() => setBinConfirm(null)}
        >
          {binConfirm.body}
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
