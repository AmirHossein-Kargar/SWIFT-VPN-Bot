/**
 * Helpers for Maps used as short-lived caches or guards, which would otherwise
 * keep every entry they ever saw: expired entries are only ignored on lookup,
 * never removed.
 */

/** Delete every entry for which `isExpired(value, key)` is true. */
export function pruneExpired(map, isExpired) {
  for (const [key, value] of map) {
    if (isExpired(value, key)) map.delete(key);
  }
}

/**
 * Delete the oldest-inserted entries until fewer than `max` remain, making room
 * for one more. Always terminates (this runs on the event loop):
 *  - `max` that is not a number or is NaN is ignored, nothing is evicted;
 *  - `max <= 0` can never be satisfied by evicting, so the map is emptied;
 *  - for a positive `max` every pass removes one existing entry.
 */
export function makeRoom(map, max) {
  if (typeof max !== "number" || Number.isNaN(max)) return;
  if (max <= 0) {
    map.clear();
    return;
  }
  while (map.size >= max) map.delete(map.keys().next().value);
}
