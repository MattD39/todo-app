import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · To-Do" };

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[400px] flex-col justify-center px-4 py-10">
      <h1 className="font-display text-[1.75rem] leading-tight font-bold tracking-tight">To-Do</h1>
      <p className="mt-1 mb-6 text-muted">Sign in to see your tasks.</p>
      {/* The form reads "?next=" from the address, so it waits for the real request. */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
