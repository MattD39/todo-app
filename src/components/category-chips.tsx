"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

// "All · Business · Fitness …" — tap one to see only that category.
//
// Each chip keeps everything else in the address (like the Calendar's
// ?day=…) and only changes ?cat=. It reads the live address, so it also sees
// a day picked on the Calendar without a page load.
export function CategoryChips({ categories, selected }: { categories: string[]; selected: string | null }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (categories.length === 0) return null;

  const hrefFor = (name: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (name) params.set("cat", name);
    else params.delete("cat");
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  };

  const chip = "flex-none rounded-full border px-3 py-[5px] text-[0.88rem]";
  const on = "border-ink bg-ink text-bg";
  const off = "border-line bg-surface text-muted";
  return (
    <nav aria-label="Filter by category" className="-mx-0.5 flex gap-1.5 overflow-x-auto p-0.5 [scrollbar-width:none]">
      {[null, ...categories].map((name) => (
        <Link
          key={name ?? "all"}
          href={hrefFor(name)}
          scroll={false}
          aria-current={name === selected ? "true" : undefined}
          className={`${chip} ${name === selected ? on : off}`}
        >
          {name ?? "All"}
        </Link>
      ))}
    </nav>
  );
}
