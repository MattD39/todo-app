"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "./actions";

const initialState: SignInState = { error: null, email: "" };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(signIn, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      <label className="flex flex-col gap-1.5 text-[0.8rem] font-bold text-muted">
        Email
        <input
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          defaultValue={state.email}
          className="rounded-[10px] border border-line bg-surface px-3 py-2.5 text-base font-normal text-ink"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-[0.8rem] font-bold text-muted">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-[10px] border border-line bg-surface px-3 py-2.5 text-base font-normal text-ink"
        />
      </label>

      {state.error && (
        <p role="alert" className="text-[0.92rem] text-high">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-1 rounded-xl bg-accent p-3.5 text-base font-bold text-accent-ink disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
