import type { ConferenceSnapshot } from "./conferenceDashboard";

/** Several admin tabs polling every 10 s cost one set of reads: the whole snapshot is kept in module memory this long. */
export const CONFERENCE_CACHE_MS = 8_000;

let cache: { at: number; promise: Promise<ConferenceSnapshot> } | null = null;

/** The snapshot (or the read still in flight) cached less than CONFERENCE_CACHE_MS ago, else null. */
export function getCachedConference(now: number): Promise<ConferenceSnapshot> | null {
  return cache && now - cache.at < CONFERENCE_CACHE_MS ? cache.promise : null;
}

/** Remember a snapshot read; a read that fails is forgotten at once so the next call tries again. */
export function setCachedConference(now: number, promise: Promise<ConferenceSnapshot>): void {
  cache = { at: now, promise };
  promise.catch(() => { if (cache?.promise === promise) cache = null; });
}

/** Test-only: forget the cached snapshot. */
export function resetConferenceCacheForTesting(): void { cache = null; }
