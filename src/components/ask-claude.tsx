"use client";

import { useEffect, useRef, useState } from "react";
import { fieldLabel, input } from "./form-styles";

// The "Ask Claude about this task" box in the task editor.
//
// Sends the task as it is in the form right now (saved or not) plus the
// question to /api/ask, then shows the answer word by word as it streams in.
// The answer isn't saved: close the editor and it's gone.
//
// It sits inside the editor's <form> (forms can't be nested), so Enter in the
// question box is caught here; otherwise it would save the task.

const MAX_QUESTION = 500;

type Status = "idle" | "asking" | "done" | "stopped";

export function AskClaude({ stepTitles }: { stepTitles: string[] }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Closing the editor mid-answer stops Claude too.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function ask() {
    const form = boxRef.current?.closest("form");
    const q = question.trim();
    if (!form || !q || status === "asking") return;
    const field = (name: string) => {
      const value = new FormData(form).get(name);
      return typeof value === "string" ? value : "";
    };
    if (!field("title").trim()) {
      setError("Give the task a title first, so Claude knows what it's about.");
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    setAnswer("");
    setStatus("asking");
    let got = "";
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({
          question: q,
          task: {
            title: field("title"),
            category: field("category"),
            notes: field("notes"),
            priority: field("priority"),
            dueDate: field("dueDate"),
            dueTime: field("dueTime"),
            repeat: field("repeat"),
            steps: stepTitles,
          },
        }),
      });

      // A redirect means the login expired (the server sent us to /login).
      if (response.redirected || !response.ok || !response.body) {
        const data: unknown = await response.json().catch(() => null);
        const message =
          typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
            ? data.error
            : "Your login may have expired. Reload the page and try again.";
        setError(message);
        setStatus("idle");
        return;
      }

      // Read the answer piece by piece and show each piece as it arrives.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        got += decoder.decode(value, { stream: true });
        setAnswer(got);
      }
      got += decoder.decode();
      setAnswer(got);
      setStatus("done");
    } catch {
      if (abort.signal.aborted) {
        setStatus(got ? "stopped" : "idle");
        return;
      }
      setStatus(got ? "done" : "idle");
      setError(
        got
          ? "The answer was cut off. Try asking again."
          : "Couldn't reach Claude. Check your connection and try again.",
      );
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  const asking = status === "asking";

  return (
    <div ref={boxRef} className={fieldLabel}>
      <label htmlFor="ask-claude-question">Ask Claude about this task</label>
      <div className="flex gap-2">
        <input
          id="ask-claude-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault(); // don't save the task
              ask();
            }
          }}
          maxLength={MAX_QUESTION}
          placeholder="e.g. How long will this take?"
          autoComplete="off"
          enterKeyHint="send"
          disabled={asking}
          className={input}
        />
        {asking ? (
          <button
            type="button"
            onClick={stop}
            className="flex-none rounded-[10px] border border-line bg-surface px-4 font-bold text-high"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={ask}
            disabled={!question.trim()}
            className="flex-none rounded-[10px] border border-line bg-surface px-4 font-bold text-accent disabled:opacity-50"
          >
            Ask
          </button>
        )}
      </div>

      {(asking || answer) && (
        <div
          aria-live="polite"
          aria-busy={asking}
          className="rounded-[10px] border border-line bg-sunk px-3 py-2.5 text-[0.95rem] font-normal whitespace-pre-wrap text-ink"
        >
          {answer || <span className="text-muted">Claude is thinking…</span>}
          {status === "stopped" && <span className="text-muted"> (stopped)</span>}
        </div>
      )}

      {error && (
        <p role="alert" className="text-[0.9rem] font-bold text-high">
          {error}
        </p>
      )}
    </div>
  );
}
