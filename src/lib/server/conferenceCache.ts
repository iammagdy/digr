/** Several admin tabs polling every 10 s cost one set of reads: the raw reads are kept in module memory this long. */
export const CONFERENCE_CACHE_MS = 8_000;

let cache: { at: number; promise: Promise<unknown> } | null = null;

/** The cached reads (or the read still in flight) cached less than CONFERENCE_CACHE_MS ago, else null. */
export function getCachedConference<T>(now: number): Promise<T> | null {
  return cache && now - cache.at < CONFERENCE_CACHE_MS ? (cache.promise as Promise<T>) : null;
}

/** Remember a read; a read that fails is forgotten at once so the next call tries again. */
export function setCachedConference<T>(now: number, promise: Promise<T>): void {
  cache = { at: now, promise };
  promise.catch(() => { if (cache?.promise === promise) cache = null; });
}

/** Test-only: forget the cached snapshot. */
export function resetConferenceCacheForTesting(): void { cache = null; }
