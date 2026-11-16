// Tailwind classes shared by the task editor's form pieces.

// A field's label, stacked above its box.
export const fieldLabel = "flex flex-col gap-[5px] text-[0.8rem] font-bold text-muted";

// A text box (input, textarea).
export const input =
  "w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 text-base font-normal text-ink disabled:opacity-50";

// One option in a segmented switch (Priority, Repeats): a hidden radio button
// inside a label, so tapping anywhere on the label picks it.
export const segment =
  "cursor-pointer rounded-lg py-2 text-center text-[0.92rem] font-normal text-muted has-checked:bg-surface has-checked:font-bold has-checked:shadow-[0_1px_2px_rgba(0,0,0,.08)] has-focus-visible:outline-2 has-focus-visible:outline-accent";
