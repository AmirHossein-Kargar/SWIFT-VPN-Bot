"use client";

import { adminGet } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import { connectionState, mergeEvents, reconnectDelayMs, snapshotIsFresh, type ConnectionState, type ReliabilityEvent, type Snapshot } from "@/lib/reliability";

const POLL_AFTER_FAILURES = 2;
const CLOCK_MS = 5_000;

export interface FeedState {
  snapshot: Snapshot | null;
  events: ReliabilityEvent[];
  connection: ConnectionState;
  failures: number;
  lastMessageAt: number | null;
  loadError: boolean;
}

type EventListener = (events: ReliabilityEvent[]) => void;

/**
 * One connection per panel session, held outside React so that tabs share it and a burst of events re-renders only what reads
 * it. The stream is the normal path. When it fails, this retries with growing delays and meanwhile asks for snapshots, so a
 * proxy that breaks SSE leaves a slower page instead of a dead one. A hidden tab holds no connection at all.
 */
export function createFeedStore(initial: Snapshot | null) {
  let state: FeedState = {
    snapshot: initial,
    events: initial?.recentEvents ?? [],
    connection: "connecting",
    failures: 0,
    lastMessageAt: initial ? Date.now() : null,
    loadError: initial == null,
  };
  const listeners = new Set<() => void>();
  const eventListeners = new Set<EventListener>();
  let source: EventSource | null = null;
  let transport: "stream" | "polling" | "none" = "none";
  let paused = false;
  let signedOut = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let clock: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let running = false;
  let cursor = "";

  function publish(next: Partial<FeedState>) {
    const merged = { ...state, ...next };
    const connection = connectionState({ transport, lastMessageAt: merged.lastMessageAt, failures: merged.failures, paused, signedOut, snapshotFresh: snapshotIsFresh(merged.snapshot, Date.now()), now: Date.now() });
    const changed = connection !== state.connection || Object.keys(next).some((key) => next[key as keyof FeedState] !== state[key as keyof FeedState]);
    if (!changed) return;
    state = { ...merged, connection };
    listeners.forEach((listener) => listener());
  }

  function receivedSnapshot(snapshot: Snapshot) {
    publish({ snapshot, events: mergeEvents(state.events, snapshot.recentEvents), lastMessageAt: Date.now(), failures: 0, loadError: false });
  }

  function closeStream() {
    source?.close();
    source = null;
  }

  function schedule() {
    if (retry || !running || paused || signedOut) return;
    retry = setTimeout(() => {
      retry = null;
      if (state.failures >= POLL_AFTER_FAILURES) void pollOnce();
      connect();
    }, reconnectDelayMs(state.failures));
  }

  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      const snapshot = await adminGet<Snapshot>("/reliability/snapshot");
      if (!source || source.readyState !== EventSource.OPEN) transport = "polling";
      publish({ snapshot, events: mergeEvents(state.events, snapshot.recentEvents), lastMessageAt: Date.now(), loadError: false });
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 401) {
        signedOut = true;
        closeStream();
        publish({});
      }
    } finally {
      polling = false;
    }
  }

  function connect() {
    if (!running || paused || signedOut || source) return;
    // A new EventSource sends no Last-Event-ID, because this store reconnects by itself, so the cursor goes in the URL.
    const stream = new EventSource(`/api/admin/reliability/stream${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    source = stream;
    stream.addEventListener("snapshot", (message) => {
      transport = "stream";
      receivedSnapshot(JSON.parse((message as MessageEvent).data));
    });
    stream.addEventListener("events", (message) => {
      const incoming = JSON.parse((message as MessageEvent).data) as ReliabilityEvent[];
      if ((message as MessageEvent).lastEventId) cursor = (message as MessageEvent).lastEventId;
      transport = "stream";
      publish({ events: mergeEvents(state.events, incoming), lastMessageAt: Date.now() });
      eventListeners.forEach((listener) => listener(incoming));
    });
    stream.addEventListener("ping", () => {
      transport = "stream";
      publish({ lastMessageAt: Date.now(), failures: 0 });
    });
    stream.addEventListener("closing", (message) => {
      const { reason } = JSON.parse((message as MessageEvent).data) as { reason: string };
      if (reason === "session_ended") { signedOut = true; publish({}); return; }
      // The server rotates long streams and closes them on a deploy. Neither is a failure, so neither counts as one.
      closeStream();
      if (reason === "reconnect") connect();
      else schedule();
    });
    stream.onerror = () => {
      // Reconnecting here rather than leaving it to the browser: EventSource gives up for good on a 401 or a 503, and the
      // retry schedule, the polling fallback and the state on screen all need to agree.
      closeStream();
      transport = transport === "polling" ? "polling" : "none";
      publish({ failures: state.failures + 1 });
      schedule();
    };
  }

  function onVisibility() {
    if (document.hidden) {
      paused = true;
      closeStream();
      if (retry) clearTimeout(retry);
      retry = null;
      transport = "none";
      publish({});
      return;
    }
    paused = false;
    publish({ failures: 0 });
    connect();
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** New events as they arrive, for transient effects that should not re-render anything. */
    onEvents(listener: EventListener) {
      eventListeners.add(listener);
      return () => { eventListeners.delete(listener); };
    },
    start() {
      running = true;
      paused = document.hidden;
      document.addEventListener("visibilitychange", onVisibility);
      clock = setInterval(() => publish({}), CLOCK_MS);
      publish({});
      connect();
    },
    stop() {
      running = false;
      document.removeEventListener("visibilitychange", onVisibility);
      if (clock) clearInterval(clock);
      if (retry) clearTimeout(retry);
      clock = null;
      retry = null;
      closeStream();
    },
  };
}

export type FeedStore = ReturnType<typeof createFeedStore>;
