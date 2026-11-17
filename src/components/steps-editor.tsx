"use client";

import { useRef, useState } from "react";
import type { StepDTO } from "@/lib/tasks";
import { addTaskStep, addTaskSteps, removeTaskStep, tickTaskStep } from "@/app/task-actions";
import { suggestTaskSteps } from "@/app/ai-actions";
import { fieldLabel, input } from "./form-styles";

// The "Steps" checklist inside the task editor sheet.
//
// • On a task that's already saved, every change (add, tick, remove) saves
//   straight away. The list updates first and the server catches up; if
//   saving fails, the change is undone and a message says why.
// • "Suggest steps" asks Claude for a few steps based on the title, category
//   and notes as they are in the form right now (saved or not), then adds
//   them like typed ones.
// • On a new task, nothing exists on the server yet, so the steps are kept
//   here and sent along when you tap "Add task" (as a hidden form field).

type Step = StepDTO & { saving?: boolean }; // saving = added, waiting for its real id

const MAX_STEPS = 50;

export function StepsEditor({ taskId, initialSteps }: { taskId: string | null; initialSteps: StepDTO[] }) {
  const [steps, setSteps] = useState<Step[]>(initialSteps);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [note, setNote] = useState<string | null>(null); // e.g. "Added 4 steps."
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);
  // Temporary ids for steps that don't have a real one yet.
  const nextTempId = useRef(0);

  async function suggest() {
    const form = fieldsetRef.current?.form;
    if (!form) return;
    const field = (name: string) => {
      const value = new FormData(form).get(name);
      return typeof value === "string" ? value : "";
    };
    if (!field("title").trim()) {
      setNote(null);
      setError("Give the task a title first, so Claude knows what it's about.");
      return;
    }
    const room = MAX_STEPS - steps.length;
    if (room <= 0) {
      setError(`A task can have up to ${MAX_STEPS} steps.`);
      return;
    }

    setError(null);
    setNote(null);
    setSuggesting(true);
    try {
      const result = await suggestTaskSteps({
        title: field("title"),
        category: field("category"),
        notes: field("notes"),
        steps: steps.map((s) => s.title),
      });
      if (!result.steps) {
        setError(result.error);
        return;
      }
      const titles = result.steps.slice(0, room);
      const added: Step[] = titles.map((title) => ({
        id: `new-${nextTempId.current++}`,
        title,
        done: false,
        saving: taskId !== null,
      }));
      setSteps((s) => [...s, ...added]);

      if (taskId) {
        const saved = await addTaskSteps(taskId, titles);
        const tempIds = new Set(added.map((a) => a.id));
        if (!saved.steps) {
          setSteps((s) => s.filter((step) => !tempIds.has(step.id)));
          setError(saved.error);
          return;
        }
        const real = saved.steps;
        setSteps((s) => [...s.filter((step) => !tempIds.has(step.id)), ...real]);
      }
      setNote(`Added ${titles.length} ${titles.length === 1 ? "step" : "steps"}. Remove any you don't need.`);
    } catch {
      setError("Couldn't reach Claude. Check your connection and try again.");
    } finally {
      setSuggesting(false);
    }
  }

  async function add() {
    const title = draft.trim();
    if (!title) return;
    if (steps.length >= MAX_STEPS) {
      setError(`A task can have up to ${MAX_STEPS} steps.`);
      return;
    }
    setError(null);
    setDraft("");
    const tempId = `new-${nextTempId.current++}`;
    setSteps((s) => [...s, { id: tempId, title, done: false, saving: taskId !== null }]);
    if (!taskId) return;

    const result = await addTaskStep(taskId, title);
    const saved = result.step;
    if (saved) {
      setSteps((s) => s.map((step) => (step.id === tempId ? saved : step)));
    } else {
      setSteps((s) => s.filter((step) => step.id !== tempId));
      setError(result.error);
    }
  }

  async function toggle(step: Step) {
    if (step.saving) return;
    const done = !step.done;
    setError(null);
    setSteps((s) => s.map((x) => (x.id === step.id ? { ...x, done } : x)));
    if (!taskId) return;

    const { error } = await tickTaskStep(step.id, done);
    if (error) {
      setSteps((s) => s.map((x) => (x.id === step.id ? { ...x, done: !done } : x)));
      setError(error);
    }
  }

  async function remove(step: Step) {
    if (step.saving) return;
    const index = steps.findIndex((x) => x.id === step.id);
    setError(null);
    setSteps((s) => s.filter((x) => x.id !== step.id));
    if (!taskId) return;

    const { error } = await removeTaskStep(step.id);
    if (error) {
      // Put it back where it was.
      setSteps((s) => [...s.slice(0, index), step, ...s.slice(index)]);
      setError(error);
    }
  }

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <fieldset ref={fieldsetRef} className={fieldLabel}>
      <legend className="mb-[5px] flex w-full justify-between">
        <span>Steps</span>
        {steps.length > 0 && (
          <span className="font-normal">
            {doneCount}/{steps.length} done
          </span>
        )}
      </legend>

      {/* A new task's steps go along with the form when it's submitted. */}
      {!taskId && (
        <input
          type="hidden"
          name="steps"
          value={JSON.stringify(steps.map(({ title, done }) => ({ title, done })))}
        />
      )}

      {steps.length > 0 && (
        <ul className="overflow-hidden rounded-[10px] border border-line bg-surface">
          {steps.map((step) => (
            <li key={step.id} className="flex items-center gap-2 border-t border-line pl-1 first:border-t-0">
              <button
                type="button"
                onClick={() => toggle(step)}
                disabled={step.saving}
                aria-label={step.done ? `Mark step "${step.title}" as not done` : `Mark step "${step.title}" as done`}
                className="group flex-none p-2 disabled:opacity-50"
              >
                <span
                  className={`grid size-[22px] place-items-center rounded-full border-2 ${
                    step.done ? "border-accent bg-accent text-accent-ink" : "border-muted text-muted"
                  }`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                    className={`size-3 ${step.done ? "opacity-100" : "opacity-0 group-hover:opacity-35"}`}
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
              </button>
              <span
                className={`min-w-0 flex-1 py-2 text-[0.95rem] font-normal [overflow-wrap:anywhere] ${
                  step.done ? "text-muted line-through" : "text-ink"
                }`}
              >
                {step.title}
              </span>
              <button
                type="button"
                onClick={() => remove(step)}
                disabled={step.saving}
                aria-label={`Remove step "${step.title}"`}
                className="flex-none px-3 py-2 text-[1.2rem] leading-none font-normal text-muted hover:text-high disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds the step instead of submitting the whole form.
            // (Not while an on-screen keyboard is still composing a word.)
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
          maxLength={200}
          placeholder="Add a step"
          aria-label="New step"
          autoComplete="off"
          enterKeyHint="done"
          className={input}
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="flex-none rounded-[10px] border border-line bg-surface px-4 font-bold text-accent disabled:opacity-50"
        >
          Add
        </button>
      </div>

      <button
        type="button"
        onClick={suggest}
        disabled={suggesting}
        className="self-start rounded-[10px] border border-line bg-surface px-4 py-2 font-bold text-accent disabled:opacity-60"
      >
        {suggesting ? "Claude is thinking…" : "✨ Suggest steps"}
      </button>

      {note && (
        <p aria-live="polite" className="text-[0.9rem] font-normal text-muted">
          {note}
        </p>
      )}

      {error && (
        <p role="alert" className="text-[0.9rem] font-bold text-high">
          {error}
        </p>
      )}
    </fieldset>
  );
}
