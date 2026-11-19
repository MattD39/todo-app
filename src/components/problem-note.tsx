"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { signInHere } from "@/app/login/actions";
import type { Problem } from "./api-problem";
import { announceSignedIn, useSignInCount } from "./signed-in";
import { useBackdropClose } from "./use-backdrop-close";

// A problem message for the Claude features (red, read out by screen readers).
// When you've been signed out it adds a Sign in button, which opens a small
// sign-in box on top of the page, so nothing you've typed is lost.
// `onSignedIn` runs once you're signed in again (e.g. to clear the message),
// whichever Sign in button you used: one sign-in clears every such message.
// `prefix`: words before the message, e.g. "Not sent." (Pass the same problem
// object between redraws, not a new one each time.)
export function ProblemNote({
  problem,
  onSignedIn,
  prefix,
}: {
  problem: Problem | null;
  onSignedIn?: () => void;
  prefix?: string;
}) {
  const [signingIn, setSigningIn] = useState(false);

  // How many sign-ins had happened when this message appeared. If there have
  // been more since, a signed-out message is out of date: hide it. (This also
  // works for a message on a hidden tab: it's checked when the tab shows again.)
  const signIns = useSignInCount();
  const [tracked, setTracked] = useState({ problem, signIns });
  if (tracked.problem !== problem) setTracked({ problem, signIns }); // a new message
  const outOfDate = problem?.code === "signed_out" && signIns > tracked.signIns;
  useEffect(() => {
    if (outOfDate) onSignedIn?.();
  }, [outOfDate, onSignedIn]);

  if (!problem || outOfDate) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.9rem] font-bold text-high">
      <span>{prefix ? `${prefix} ${problem.message}` : problem.message}</span>
      {problem.code === "signed_out" && (
        <button
          type="button"
          onClick={() => setSigningIn(true)}
          className="rounded-full bg-accent px-3.5 py-1.5 text-[0.9rem] font-bold text-accent-ink"
        >
          Sign in
        </button>
      )}
      {signingIn && (
        <SignInDialog
          onClose={() => setSigningIn(false)}
          onSignedIn={() => {
            setSigningIn(false);
            announceSignedIn(); // clears this message and every other signed-out one
          }}
        />
      )}
    </div>
  );
}

// The sign-in box. It's put at the end of the page (a "portal"), outside any
// form or sheet it was opened from, so pressing Enter here can't save a task.
function SignInDialog({ onClose, onSignedIn }: { onClose: () => void; onSignedIn: () => void }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const backdropClose = useBackdropClose(onClose);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    e.stopPropagation(); // React passes events up through portals: keep it from the task form
    const data = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const result = await signInHere(data.get("email"), data.get("password"));
      if (result.error) {
        setError(result.error);
        return;
      }
      // Reload the lists from the server (what's on screen and typed stays).
      router.refresh();
      onSignedIn();
    } catch {
      setError("Couldn't sign in. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const box = "rounded-[10px] border border-line bg-surface px-3 py-2.5 text-base font-normal text-ink";
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby="sign-in-title"
      // React passes events up through portals, so without stopPropagation
      // closing this box would also close the task editor it was opened from.
      onCancel={(e) => e.stopPropagation()}
      onClose={(e) => {
        e.stopPropagation();
        onClose();
      }}
      {...backdropClose}
      className="m-auto w-[min(360px,calc(100%-32px))] rounded-[18px] bg-bg p-0 text-ink backdrop:bg-[rgba(10,16,12,.45)]"
    >
      <form onSubmit={submit} className="sheet-in flex flex-col gap-3.5 p-5">
        <div>
          <h2 id="sign-in-title" className="font-display text-[1.15rem] font-bold">
            Sign in again
          </h2>
          <p className="mt-1 text-[0.95rem] text-muted">Everything on the page stays as it is.</p>
        </div>
        <label className="flex flex-col gap-1.5 text-[0.8rem] font-bold text-muted">
          Email
          <input name="email" type="email" autoComplete="email" inputMode="email" required className={box} />
        </label>
        <label className="flex flex-col gap-1.5 text-[0.8rem] font-bold text-muted">
          Password
          <input name="password" type="password" autoComplete="current-password" required className={box} />
        </label>
        {error && (
          <p role="alert" className="text-[0.92rem] text-high">
            {error}
          </p>
        )}
        <div className="mt-1 grid grid-cols-2 gap-2.5">
          <button type="button" onClick={onClose} className="rounded-xl border border-line bg-surface p-3 font-bold text-ink">
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-accent p-3 font-bold text-accent-ink disabled:opacity-60"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
