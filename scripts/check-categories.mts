//
// Checks the category chips' rules (several chips can be on at once).
//
// Run with: npm run check:categories
//
// Free and quick: no Claude, no database. Checks the plain rules in
// src/lib/views.ts that the chips, the screens and Add task use:
//   - which chips are on, read from the address bar (?cat=Work&cat=Fitness);
//   - what tapping a chip does (on/off; the last one off = All; All clears);
//   - which tasks show (the picked categories together, or all);
//   - the category a new task starts in (only when exactly one chip is on);
//   - the address bar keeps names with spaces, commas and "&" intact.
// Exits with an error if any check fails.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { TaskDTO } from "../src/lib/tasks.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@/": path.join(root, "src") + path.sep } });
const views = await jiti.import<typeof import("../src/lib/views.ts")>(path.join(root, "src/lib/views.ts"));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `\n      ${detail}` : ""}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const known = ["Errands", "Fitness", "Work"]; // the chips, in their order

console.log("\nWhich chips are on (from the address bar)\n");
check("none in the address = All (nothing picked)", same(views.pickedCategories(undefined, known), []));
check("one", same(views.pickedCategories("Work", known), ["Work"]));
check(
  "several, kept in the chips' order",
  same(views.pickedCategories(["Work", "Errands"], known), ["Errands", "Work"]),
);
check(
  "unknown names are left out (e.g. a category with no tasks left)",
  same(views.pickedCategories(["Work", "Gone"], known), ["Work"]),
);
check("the same one twice counts once", same(views.pickedCategories(["Work", "Work"], known), ["Work"]));
check("only unknown names = All", same(views.pickedCategories("Gone", known), []));

console.log("\nTapping a chip\n");
check("tap a chip from All: just that one", same(views.toggleCategory([], "Work", known), ["Work"]));
check("tap a second chip: both on", same(views.toggleCategory(["Work"], "Fitness", known), ["Fitness", "Work"]));
check("tap a chip that's on: it turns off", same(views.toggleCategory(["Fitness", "Work"], "Work", known), ["Fitness"]));
check("turn the last one off: back to All", same(views.toggleCategory(["Work"], "Work", known), []));
check("tap All: every other chip turns off", same(views.toggleCategory(["Fitness", "Work"], null, known), []));
check("tap All when already on All: still All", same(views.toggleCategory([], null, known), []));

console.log("\nWhich tasks show\n");
const task = (title: string, category: string | null) =>
  ({ id: title, title, category: category ? { id: category, name: category } : null }) as TaskDTO;
const tasks = [task("Gym", "Fitness"), task("Report", "Work"), task("Milk", "Errands"), task("Nap", null)];
const titles = (list: TaskDTO[]) => list.map((t) => t.title);
check("All: every task, with or without a category", same(titles(views.inCategories(tasks, [])), ["Gym", "Report", "Milk", "Nap"]));
check("Work: only Work's", same(titles(views.inCategories(tasks, ["Work"])), ["Report"]));
check(
  "Work and Fitness: both categories' tasks together",
  same(titles(views.inCategories(tasks, ["Fitness", "Work"])), ["Gym", "Report"]),
);
check("a task with no category shows only under All", !views.inCategories(tasks, ["Work"]).some((t) => t.title === "Nap"));

console.log("\nThe category a new task starts in\n");
check("All: none", views.defaultCategory([]) === null);
check("exactly one chip on: that one", views.defaultCategory(["Work"]) === "Work");
check("several chips on: none, so you pick (option A)", views.defaultCategory(["Fitness", "Work"]) === null);

console.log("\nThe address bar\n");
const params = views.setCategoryParams(new URLSearchParams("day=2026-11-24&cat=Old"), ["Kids & school", "Bills, rent"]);
check(
  "one cat= per chip, other parts kept, the old cat= replaced",
  same(params.getAll("cat"), ["Kids & school", "Bills, rent"]) && params.get("day") === "2026-11-24",
  params.toString(),
);
check(
  "names with spaces, commas and & survive a round trip",
  same(views.pickedCategories(new URLSearchParams(params.toString()).getAll("cat"), ["Bills, rent", "Kids & school"]), [
    "Bills, rent",
    "Kids & school",
  ]),
);
check("no chips: no cat= at all", !views.setCategoryParams(new URLSearchParams("cat=Work"), []).has("cat"));

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
