import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { formatDay, nowIn } from "@/lib/dates";
import { listCategories, listOpenTasks, listSavedCategoryNames } from "@/lib/tasks";
import { getTimeZone } from "@/lib/timezone";
import { buildStats, defaultCategory, pickedCategories, setCategoryParams } from "@/lib/views";
import { TimeZoneSync } from "@/app/timezone-sync";
import { TaskEditorProvider } from "./task-editor";
import { CategoryChips } from "./category-chips";
import { SettingsButton, SettingsButtonPlaceholder } from "./settings-menu";
import { RefreshOnReturn } from "./refresh-on-return";
import { ChatTabDot } from "./chat-tab-dot";
import { EditButton, EditModeProvider } from "./edit-mode";
import { SelectionBar } from "./selection-bar";

export { Status } from "./status";

// The frame shared by the Today, Upcoming, Calendar, Done and Chat screens: title + date,
// summary line, category filter chips, the add/edit editor, and the tab bar.

export type Tab = "today" | "upcoming" | "calendar" | "done" | "chat";

const TABS: { tab: Tab; label: string; path: string; icon: React.ReactNode }[] = [
  {
    tab: "today",
    label: "Today",
    path: "/",
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>
    ),
  },
  { tab: "upcoming", label: "Upcoming", path: "/upcoming", icon: <path d="M4 6h16M4 12h10M4 18h6" /> },
  {
    tab: "calendar",
    label: "Calendar",
    path: "/calendar",
    icon: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </>
    ),
  },
  { tab: "done", label: "Done", path: "/done", icon: <path d="M20 6 9 17l-5-5" /> },
  {
    tab: "chat",
    label: "Chat",
    path: "/chat",
    icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  },
];

const TITLES: Record<Tab, string> = {
  today: "Today",
  upcoming: "Upcoming",
  calendar: "Calendar",
  done: "Done",
  chat: "Chat",
};

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Loads what every screen needs. The category chips that are on come from the
// address bar (?cat=Work&cat=Fitness) so they survive a refresh and carry
// across tabs. None on = "All".
export async function loadScreen(searchParams: SearchParams) {
  const [user, timeZone, params] = await Promise.all([getCurrentUser(), getTimeZone(), searchParams]);
  const [open, categoryRows, savedCategories] = await Promise.all([
    listOpenTasks(),
    listCategories(),
    listSavedCategoryNames(),
  ]);
  const categories = categoryRows.map((c) => c.name);
  // Unknown names (e.g. a category whose last task was deleted) are left out.
  const picked = pickedCategories(params.cat, categories);
  // categories: the chips; savedCategories: the task sheet's Category list.
  return { user, timeZone, now: nowIn(timeZone), open, categories, savedCategories, picked };
}

export type ScreenData = Awaited<ReturnType<typeof loadScreen>>;

// The screens where you can select several tasks with Edit (the ones with
// swipe to delete).
const EDIT_TABS: Tab[] = ["today", "upcoming", "done"];

export function Screen({ tab, data, children }: { tab: Tab; data: ScreenData; children: React.ReactNode }) {
  const screen = <ScreenFrame tab={tab} data={data}>{children}</ScreenFrame>;
  return EDIT_TABS.includes(tab) ? <EditModeProvider>{screen}</EditModeProvider> : screen;
}

function ScreenFrame({ tab, data, children }: { tab: Tab; data: ScreenData; children: React.ReactNode }) {
  const stats = buildStats(data.open, data.now);
  const chips = <CategoryChips categories={data.categories} picked={data.picked} />;
  return (
    <TaskEditorProvider
      savedCategories={data.savedCategories}
      defaultCategory={defaultCategory(data.picked)}
      today={data.now.today}
      showAddButton={tab !== "chat"} // it would sit on top of the chat's Send button
      enterToAdd={tab === "today" || tab === "upcoming" || tab === "calendar"}
    >
      <TimeZoneSync serverTimeZone={data.timeZone} savedTimeZone={data.user.timeZone} />
      <RefreshOnReturn />
      <ScreenHeader
        tab={tab}
        email={data.user.email ?? ""}
        dateLine={formatDay(data.now.today)}
        stats={
          <>
            <b className="text-ink">{stats.dueToday}</b> due today ·{" "}
            {stats.overdue ? (
              <span className="text-high">
                <b>{stats.overdue}</b> overdue
              </span>
            ) : (
              "nothing overdue"
            )}{" "}
            · {stats.open} open
          </>
        }
      >
        {/* The chat always looks at every task, so the category filter doesn't apply there. */}
        {EDIT_TABS.includes(tab) ? (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">{chips}</div>
            <EditButton />
          </div>
        ) : (
          tab !== "chat" && chips
        )}
      </ScreenHeader>

      {children}

      <TabBar current={tab} picked={data.picked} />
      {/* Covers the tab bar while selecting tasks (edit mode only). */}
      <SelectionBar />
    </TaskEditorProvider>
  );
}

// Shown on its own while a screen loads, so the title and tab bar don't jump.
export function ScreenLoading({ tab }: { tab: Tab }) {
  return (
    <>
      <ScreenHeader tab={tab} />
      <TabBar current={tab} picked={[]} />
    </>
  );
}

function ScreenHeader({
  tab,
  email,
  dateLine,
  stats,
  children,
}: {
  tab: Tab;
  email?: string; // missing while the screen loads
  dateLine?: string;
  stats?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="sticky top-[env(safe-area-inset-top,0px)] z-[5] flex flex-col gap-2.5 bg-bg pt-3.5 pb-2.5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-[1.75rem] leading-[1.1] font-bold tracking-[-0.01em]">{TITLES[tab]}</h1>
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[0.78rem] font-medium tracking-[0.06em] whitespace-nowrap text-muted uppercase">
            {dateLine}
          </span>
          {email === undefined ? <SettingsButtonPlaceholder /> : <SettingsButton email={email} />}
        </div>
      </div>
      <div className="text-[0.92rem] text-muted">{stats ?? " "}</div>
      {children}
    </header>
  );
}

function hrefFor(tab: Tab, picked: string[]) {
  const path = TABS.find((t) => t.tab === tab)!.path;
  const query = setCategoryParams(new URLSearchParams(), picked).toString();
  return query ? `${path}?${query}` : path;
}

function TabBar({ current, picked }: { current: Tab; picked: string[] }) {
  return (
    <nav
      aria-label="Screens"
      className="fixed inset-x-0 bottom-0 z-[6] grid grid-cols-5 border-t border-line bg-surface pr-[max(8px,env(safe-area-inset-right,0px))] pb-[env(safe-area-inset-bottom,0px)] pl-[max(8px,env(safe-area-inset-left,0px))]"
    >
      {TABS.map(({ tab, label, icon }) => (
        <Link
          key={tab}
          href={hrefFor(tab, picked)}
          aria-current={tab === current ? "page" : undefined}
          className={`flex h-16 flex-col items-center justify-center gap-[3px] text-[0.74rem] ${
            tab === current ? "font-bold text-accent" : "text-muted"
          }`}
        >
          <span className="relative">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="size-[22px]"
            >
              {icon}
            </svg>
            {tab === "chat" && <ChatTabDot />}
          </span>
          {label}
        </Link>
      ))}
    </nav>
  );
}
