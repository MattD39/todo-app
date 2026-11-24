"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { setCategoryParams, toggleCategory } from "@/lib/views";

// "All · Business · Fitness …": tap chips to see only those categories'
// tasks, together. Tapping a chip that's on turns it off; turning the last one
// off goes back to All; tapping All turns every other chip off.
//
// Each chip keeps everything else in the address (like the Calendar's
// ?day=…) and only changes the cat= parts (one per chip that's on). It reads
// the live address, so it also sees a day picked on the Calendar without a
// page load.
export function CategoryChips({ categories, picked }: { categories: string[]; picked: string[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (categories.length === 0) return null;

  const hrefFor = (name: string | null) => {
    const params = setCategoryParams(new URLSearchParams(searchParams), toggleCategory(picked, name, categories));
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  };

  const chip = "flex-none rounded-full border px-3 py-[5px] text-[0.88rem]";
  const on = "border-ink bg-ink text-bg";
  const off = "border-line bg-surface text-muted";
  return (
    <nav aria-label="Filter by category" className="-mx-0.5 flex gap-1.5 overflow-x-auto p-0.5 [scrollbar-width:none]">
      {[null, ...categories].map((name) => {
        const isOn = name === null ? picked.length === 0 : picked.includes(name);
        return (
          <Link
            key={name ?? "all"}
            href={hrefFor(name)}
            scroll={false}
            aria-current={isOn ? "true" : undefined}
            className={`${chip} ${isOn ? on : off}`}
          >
            {name ?? "All"}
          </Link>
        );
      })}
    </nav>
  );
}
