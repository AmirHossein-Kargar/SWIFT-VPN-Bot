"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { adminGet } from "@/lib/adminApi.client";
import { feedDelayMs, feedHealth, mergeFeedEvents, overlapCursor, type FeedEvent, type FeedHealth, type LiveFeed } from "@/lib/sentinel";

export interface LiveFeedFilters {
  provider: string;
  stage: string;
  minAmount: string;
  maxAmount: string;
  userId: string;
}

/**
 * The feed is polling, and says so. One request at a time, none while the tab is hidden, and a failure slows down instead
 * of hammering. Each cursor overlaps the previous one so nothing written just behind a poll is lost; the overlap and any
 * reconnect repeat events, which is harmless because they merge by id.
 */
export function useLiveFeed(initial: LiveFeed, filters: LiveFeedFilters) {
  const [events, setEvents] = useState<FeedEvent[]>(initial.events);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [gap, setGap] = useState(initial.truncated);
  const [degraded, setDegraded] = useState(initial.degraded);
  const [openFindings, setOpenFindings] = useState(initial.openFindings);
  const [paused, setPaused] = useState(false);
  const [failures, setFailures] = useState(0);
  const [now, setNow] = useState<number | null>(null);
  const cursor = useRef(overlapCursor(initial.nextSince));
  const failureCount = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const firstFilters = useRef(true);

  const poll = useCallback(async () => {
    if (document.hidden) { setPaused(true); return; }
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const timeout = setTimeout(() => controller.abort(), 9_000);
    try {
      const feed = await adminGet<LiveFeed>("/sentinel/live", { since: cursor.current, limit: 100, ...filters }, { signal: controller.signal });
      cursor.current = overlapCursor(feed.nextSince);
      failureCount.current = 0;
      setFailures(0);
      setEvents((current) => mergeFeedEvents(current, feed.events));
      setGap(feed.truncated);
      setDegraded(feed.degraded);
      setOpenFindings(feed.openFindings);
      setLastSyncAt(Date.now());
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError" && !document.hidden && controller !== inFlight.current)) {
        failureCount.current += 1;
        setFailures(failureCount.current);
      }
    } finally {
      clearTimeout(timeout);
      if (controller === inFlight.current) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(poll, feedDelayMs(failureCount.current));
      }
    }
  }, [filters]);

  useEffect(() => {
    setLastSyncAt(Date.now());
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    // A filter change is a new question: the old rows do not answer it, and the cursor starts over.
    if (firstFilters.current) firstFilters.current = false;
    else {
      setEvents([]);
      cursor.current = "";
      poll();
    }
  }, [poll]);

  useEffect(() => {
    timer.current = setTimeout(poll, feedDelayMs(0));
    const onVisibility = () => {
      if (document.hidden) return;
      setPaused(false);
      if (timer.current) clearTimeout(timer.current);
      poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer.current) clearTimeout(timer.current);
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [poll]);

  const health: FeedHealth = feedHealth({ lastSyncAt, paused, now: now ?? 0 });
  return { events, health, failures, gap, degraded, openFindings, lastSyncAt, now };
}
