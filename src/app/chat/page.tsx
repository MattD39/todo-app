import { Suspense } from "react";
import { Chat } from "@/components/chat";
import { ChatFrame } from "@/components/chat-frame";
import { loadScreen, Screen, ScreenLoading, type SearchParams } from "@/components/screen";

// The Chat screen: ask Claude about your tasks. Claude can read them but not change them.
export default function ChatPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    // A fixed column that fits the visible screen, even with the iPhone keyboard up.
    <ChatFrame>
      <Suspense fallback={<ScreenLoading tab="chat" />}>
        <ChatScreen searchParams={searchParams} />
      </Suspense>
    </ChatFrame>
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
