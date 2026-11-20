import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSignedInUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DecisionButtons } from "./decision-buttons";

export const metadata: Metadata = { title: "Allow access · To-Do" };

// /oauth/consent: the "Allow Claude?" page. When you connect Claude (or
// another app) to your To-Do list, Supabase sends you here with
// ?authorization_id=… (this path is set in Supabase: Authentication →
// OAuth Server → Authorization Path). You must be signed in first; the proxy
// sends you to sign in and back here if you aren't.
export default function ConsentPage({ searchParams }: PageProps<"/oauth/consent">) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[440px] flex-col justify-center px-4 py-10">
      <h1 className="font-display text-[1.75rem] leading-tight font-bold tracking-tight">To-Do</h1>
      <Suspense fallback={<p className="mt-4 text-muted">Loading…</p>}>
        <Consent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Consent({ searchParams }: { searchParams: PageProps<"/oauth/consent">["searchParams"] }) {
  const params = await searchParams;
  const id = typeof params.authorization_id === "string" ? params.authorization_id : "";
  if (!id) return <Problem>This page needs a request from an app. Go back to Claude and try connecting again.</Problem>;

  const user = await getSignedInUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${id}`)}`);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(id);
  if (error || !data) {
    return <Problem>This request has expired or isn&apos;t valid. Go back to Claude and try connecting again.</Problem>;
  }
  // You already allowed this app before: straight back to it.
  if (!("authorization_id" in data)) redirect(data.redirect_url);

  // Where you'll be sent afterwards. Apps name themselves, so this is a
  // useful check that it's really the app you meant.
  let returnsTo = data.redirect_uri;
  try {
    returnsTo = new URL(data.redirect_uri).host || data.redirect_uri;
  } catch {
    // Not a normal web address: show it as it is.
  }

  return (
    <>
      <p className="mt-1 text-muted">Signed in as {data.user.email || user.email}</p>
      <h2 className="mt-6 font-display text-[1.3rem] font-bold">Allow {data.client.name || "this app"} to use your To-Do list?</h2>
      <p className="mt-3">It will be able to:</p>
      <ul className="mt-1.5 list-disc pl-5">
        <li>see your tasks, their steps and notes, and what you&apos;ve finished</li>
        <li>add tasks, change them and tick them off</li>
      </ul>
      <p className="mt-3">It can&apos;t delete tasks, and it can only see your account.</p>
      <p className="mt-3 text-[0.92rem] text-muted">
        After you choose, you&apos;ll go back to <b className="text-ink">{returnsTo}</b>. Only allow apps you trust.
      </p>
      <DecisionButtons authorizationId={data.authorization_id} />
    </>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="mt-4 font-bold text-high">
      {children}
    </p>
  );
}
