"use client";

import { useActionState } from "react";
import { decide, type DecisionState } from "./actions";

// The Deny / Allow buttons on the "Allow Claude?" page.
export function DecisionButtons({ authorizationId }: { authorizationId: string }) {
  const [state, formAction, pending] = useActionState<DecisionState, FormData>(decide, { error: null });
  return (
    <form action={formAction} className="mt-6 flex flex-col gap-3">
      <input type="hidden" name="authorization_id" value={authorizationId} />
      {state.error && (
        <p role="alert" className="text-[0.92rem] font-bold text-high">
          {state.error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="submit"
          name="decision"
          value="deny"
          disabled={pending}
          className="rounded-xl border border-line bg-surface p-3.5 font-bold text-ink disabled:opacity-60"
        >
          Deny
        </button>
        <button
          type="submit"
          name="decision"
          value="allow"
          disabled={pending}
          className="rounded-xl bg-accent p-3.5 font-bold text-accent-ink disabled:opacity-60"
        >
          {pending ? "One moment…" : "Allow"}
        </button>
      </div>
    </form>
  );
}
