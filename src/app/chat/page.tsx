import { Suspense } from "react";
import { Chat } from "@/components/chat";
import { loadScreen, Screen, ScreenLoading, type SearchParams } from "@/components/screen";

// The Chat screen: ask Claude about your tasks. Claude can read them but not change them.
export default function ChatPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    // Extra room at the bottom for the message box that sits above the tab bar.
    <main className="mx-auto max-w-[640px] px-4 pb-44">
      <Suspense fallback={<ScreenLoading tab="chat" />}>
        <ChatScreen searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function ChatScreen({ searchParams }: { searchParams: SearchParams }) {
  const data = await loadScreen(searchParams);
  return (
    <Screen tab="chat" data={data}>
      <Chat />
    </Screen>
  );
}
