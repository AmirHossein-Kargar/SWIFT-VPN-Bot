/**
 * Server-Sent Events for the panel: one-way, one process, no dependency. Reads are in memory, so a viewer adds no database load.
 *
 * What a long-lived response must get right, and where this does:
 *   - Access can end while the stream is open, so the session is re-checked on a timer and the stream closes when it lapses.
 *   - A viewer can stop reading. A slow socket is dropped rather than buffered without limit.
 *   - Connections are capped, per admin and overall.
 *   - `http.Server.close()` waits for open responses, so an unclosed stream would hang a deploy: closeAll() runs before it.
 *   - A proxy may cut any long response, so each stream ends by itself and the browser reconnects with its last id.
 */
const DEFAULTS = Object.freeze({ heartbeatMs: 15_000, revalidateMs: 60_000, maxAgeMs: 10 * 60_000, maxClients: 24, maxPerAdmin: 4, maxBufferedBytes: 1_048_576, batchMs: 1_000 });

export class StreamCapacityError extends Error {
  constructor() { super("Too many live connections."); this.name = "StreamCapacityError"; }
}

const frame = ({ event, data, id }) => `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createStreamHub({ revalidate = async () => true, now = Date.now, ...options } = {}) {
  const settings = { ...DEFAULTS, ...options };
  const clients = new Set();
  let timer = null;
  let flushTimer = null;
  const pending = [];
  let lastCheckAt = now();

  function drop(client, reason) {
    if (!clients.delete(client)) return;
    try {
      if (reason) client.res.write(frame({ event: "closing", data: { reason } }));
      client.res.end();
    } catch { /* the socket is already gone */ }
    if (!clients.size) stopTimers();
  }

  function send(client, payload) {
    if (client.res.writableEnded || client.res.destroyed) { drop(client); return; }
    if (client.res.writableLength > settings.maxBufferedBytes) { drop(client); return; }
    try { client.res.write(payload); } catch { drop(client); }
  }

  async function heartbeat() {
    const at = now();
    const ping = frame({ event: "ping", data: { serverTime: new Date(at).toISOString() } });
    const recheck = at - lastCheckAt >= settings.revalidateMs;
    if (recheck) lastCheckAt = at;
    for (const client of [...clients]) {
      if (at - client.openedAt > settings.maxAgeMs) { drop(client, "reconnect"); continue; }
      send(client, ping);
      if (!recheck) continue;
      // Fail closed: an unavailable session store is not proof of access.
      const allowed = await revalidate(client).catch(() => false);
      if (!allowed) drop(client, "session_ended");
    }
  }

  function startTimers() {
    if (timer) return;
    timer = setInterval(() => { heartbeat().catch(() => {}); }, settings.heartbeatMs);
    timer.unref?.();
  }

  function stopTimers() {
    if (timer) clearInterval(timer);
    if (flushTimer) clearTimeout(flushTimer);
    timer = null;
    flushTimer = null;
    pending.length = 0;
  }

  function broadcast(payload) {
    for (const client of [...clients]) send(client, payload);
  }

  function flushPending() {
    flushTimer = null;
    if (!pending.length) return;
    const batch = pending.splice(0, 50);
    const last = batch[batch.length - 1];
    broadcast(frame({ event: "events", id: last.cursor, data: batch.map((item) => item.event) }));
    if (pending.length) { flushTimer = setTimeout(flushPending, settings.batchMs); flushTimer.unref?.(); }
  }

  return {
    attach({ req, res, actorId, token, initial = [] }) {
      if (clients.size >= settings.maxClients || [...clients].filter((client) => client.actorId === actorId).length >= settings.maxPerAdmin) {
        throw new StreamCapacityError();
      }
      req.socket?.setKeepAlive?.(true);
      req.setTimeout?.(0);
      res.status(200);
      res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders?.();
      const client = { res, actorId, token, openedAt: now() };
      clients.add(client);
      res.write("retry: 5000\n\n");
      for (const message of initial) send(client, frame(message));
      res.once("close", () => drop(client));
      startTimers();
      return client;
    },
    publish(event, data, id) {
      if (clients.size) broadcast(frame({ event, data, id }));
    },
    /** Events arrive in bursts, so they are batched: one write a second however many there were. */
    queueEvent(event, cursor) {
      if (!clients.size) return;
      pending.push({ event, cursor });
      if (pending.length > 500) pending.shift();
      if (!flushTimer) { flushTimer = setTimeout(flushPending, settings.batchMs); flushTimer.unref?.(); }
    },
    closeAll(reason = "server_stopping") {
      for (const client of [...clients]) drop(client, reason);
      stopTimers();
    },
    size: () => clients.size,
  };
}
