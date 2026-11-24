"use client";

import { useId, useRef, useState, useTransition } from "react";
import { addCategory } from "@/app/task-actions";

// The task sheet's Category box ("like contacts").
//
// You can type any category. Tapping into the box (or the ▾ button) opens a
// list of your SAVED categories under it, with "+ Add category…" at the
// bottom, which saves a new one and picks it. A typed name that isn't saved
// is a one-off: it's only for this task, and a small "Save to list" link
// beside it puts it on your saved list without going to Settings. (Deleting a
// saved category is only possible in Settings → Categories.)
//
// The list opens inside the sheet, pushing the fields below it down, rather
// than floating over them, so a phone's keyboard can never hide or clip it.

const ADD = "\u0000add"; // the "+ Add category…" row in the list

export function CategoryField({
  saved,
  initial,
  labelClassName,
  inputClassName,
}: {
  saved: string[]; // the saved list, A–Z
  initial: string; // the task's category, or where a new task starts
  labelClassName: string;
  inputClassName: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [value, setValue] = useState(initial);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1); // the highlighted row (arrow keys)
  const [adding, setAdding] = useState(false); // "+ Add category…" box showing
  const [newName, setNewName] = useState("");
  const [note, setNote] = useState<{ text: string; isError: boolean } | null>(null);
  const [busy, startBusy] = useTransition();
  // Names saved from this box, until the page's fresh list arrives.
  const [justSaved, setJustSaved] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const all = [...new Set([...saved, ...justSaved])].sort((a, b) => a.localeCompare(b));
  const savedName = (name: string) => all.find((s) => s.toLowerCase() === name.trim().toLowerCase());
  const typed = value.trim();
  const isOneOff = typed !== "" && !savedName(typed);
  // While typing part of a name, only the saved ones that contain it.
  const shown = isOneOff ? all.filter((s) => s.toLowerCase().includes(typed.toLowerCase())) : all;
  const rows = [...shown, ADD];

  function pick(name: string) {
    if (name === ADD) {
      setAdding(true);
      setNewName(isOneOff ? typed : "");
      setOpen(false);
      return;
    }
    setValue(name);
    setNote(null);
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  }

  // Saves `name` to the list; then `then` runs with the saved name.
  function save(name: string, then: (savedAs: string) => void) {
    startBusy(async () => {
      setNote(null);
      const result = await addCategory(name);
      if (result.error || !result.value) {
        setNote({ text: result.error ?? "Couldn't save it. Try again.", isError: true });
        return;
      }
      const savedAs = result.value.name;
      setJustSaved((list) => [...list, savedAs]);
      then(savedAs);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => {
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        return (next + rows.length) % rows.length;
      });
    } else if (e.key === "Enter" && open && active >= 0 && active < rows.length) {
      e.preventDefault(); // picks the highlighted row instead of saving the task
      pick(rows[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault(); // closes the list, not the whole sheet
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  }

  const row = "flex w-full items-center px-3 py-2.5 text-left";
  return (
    <div
      className={labelClassName}
      // Leaving the whole field (not just moving within it) closes the list.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setActive(-1);
        }
      }}
    >
      <label htmlFor={`${id}-input`}>Category</label>
      <div className="relative">
        <input
          id={`${id}-input`}
          ref={inputRef}
          name="category"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-row-${active}` : undefined}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setNote(null);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          maxLength={40}
          placeholder="Pick or type a category"
          autoComplete="off"
          enterKeyHint="done"
          className={`${inputClassName} pr-10`}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? "Hide saved categories" : "Show saved categories"}
          onMouseDown={(e) => e.preventDefault()} // keeps the box focused
          onClick={() => {
            setOpen((o) => !o);
            inputRef.current?.focus();
          }}
          className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted"
        >
          ▾
        </button>
      </div>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Saved categories"
          // Tapping a row mustn't move focus away first (that would close the list).
          onMouseDown={(e) => e.preventDefault()}
          className="mt-1.5 max-h-56 overflow-y-auto rounded-[10px] border border-line bg-surface text-[0.95rem] font-normal text-ink"
        >
          {shown.length === 0 && (
            <li className="px-3 py-2.5 text-muted">{all.length === 0 ? "No saved categories yet." : "No saved match."}</li>
          )}
          {rows.map((name, i) => (
            <li
              key={name}
              id={`${id}-row-${i}`}
              role="option"
              aria-selected={i === active}
              onClick={() => pick(name)}
              className={`${row} cursor-pointer border-t border-line first:border-t-0 ${i === active ? "bg-accent-soft" : ""} ${
                name === ADD ? "font-bold text-accent" : ""
              }`}
            >
              {name === ADD ? "+ Add category…" : name}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        // Not a <form>: it sits inside the task's form. Enter saves; Esc cancels.
        <div className="mt-1.5 flex gap-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault(); // saves the category, not the task
                if (newName.trim()) {
                  save(newName, (savedAs) => {
                    setValue(savedAs);
                    setAdding(false);
                    setNote({ text: `“${savedAs}” is saved to your list.`, isError: false });
                  });
                }
              } else if (e.key === "Escape") {
                e.preventDefault(); // cancels this, not the whole sheet
                e.stopPropagation();
                setAdding(false);
                inputRef.current?.focus();
              }
            }}
            aria-label="New category name"
            placeholder="New category"
            maxLength={40}
            className={`${inputClassName} min-w-0 flex-1`}
          />
          <button
            type="button"
            disabled={busy || !newName.trim()}
            onClick={() =>
              save(newName, (savedAs) => {
                setValue(savedAs);
                setAdding(false);
                setNote({ text: `“${savedAs}” is saved to your list.`, isError: false });
              })
            }
            className="rounded-xl bg-accent px-3 text-[0.9rem] font-bold text-accent-ink disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              inputRef.current?.focus();
            }}
            className="rounded-xl border border-line px-3 text-[0.9rem] font-bold text-muted"
          >
            Cancel
          </button>
        </div>
      )}

      {/* A typed name that isn't saved: just for this task, unless you save it. */}
      {isOneOff && !adding && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[0.85rem] font-normal text-muted">
          <span>Just for this task.</span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              save(typed, (savedAs) => {
                setValue(savedAs);
                setNote({ text: `“${savedAs}” is saved to your list.`, isError: false });
              })
            }
            className="font-bold text-accent underline underline-offset-2 disabled:opacity-50"
          >
            Save to list
          </button>
        </p>
      )}
      {note && (
        <p role={note.isError ? "alert" : "status"} className={`mt-1.5 text-[0.85rem] ${note.isError ? "font-bold text-high" : "font-normal text-muted"}`}>
          {note.text}
        </p>
      )}
    </div>
  );
}
