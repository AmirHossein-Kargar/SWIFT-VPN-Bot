"use client";

import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";

import { createFeedStore, type FeedState, type FeedStore } from "@/components/reliability/feed-store";
import type { Snapshot } from "@/lib/reliability";

const FeedContext = createContext<FeedStore | null>(null);

/** Lives in the section layout, so moving between tabs keeps the one connection open. */
export function ReliabilityFeedProvider({ initial, children }: { initial: Snapshot | null; children: React.ReactNode }) {
  const store = useRef<FeedStore | null>(null);
  store.current ||= createFeedStore(initial);

  useEffect(() => {
    const feed = store.current!;
    feed.start();
    return () => feed.stop();
  }, []);

  return <FeedContext.Provider value={store.current}>{children}</FeedContext.Provider>;
}

export function useFeedStore(): FeedStore {
  const store = useContext(FeedContext);
  if (!store) throw new Error("useFeedStore needs ReliabilityFeedProvider");
  return store;
}

/** Subscribes to one slice, so a new event re-renders the feed and not the charts. The selector must return a stable value. */
export function useFeed<T>(select: (state: FeedState) => T): T {
  const store = useFeedStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()), () => select(store.getState()));
}
