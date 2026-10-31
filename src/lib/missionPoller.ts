/**
 * THE POLLING LOOP OF A CARD OR A PANEL THAT MUST NEVER GO DEAF. Live (2026-10-31, a YouTube request): the plan was stored at 16:46:35 and the card still said «الخطوة الحالية تستغرق وقتًا أطول من المعتاد» until the page was reloaded after 16:48. The old loops
 * read, AWAITED the read and only then armed the next one, so a read that never settled (a request that hangs after a network change, a session read that waits for a lock) ended the loop for good; only a reload restarted it.
 *
 * Here every read has a LIMIT: when it has not answered by then the loop goes on without it (its answer, if it ever comes, is still used by whoever started it); a read that throws is followed by the next like any other; the next read is armed
 * when the previous one answered OR the limit passed; `stop()` ends this loop and only this loop (a new loop never revives an old one). No timer outlives `stop()`.
 */
export interface MissionPollingOptions {
  /** One read; it may fail or never answer. */
  read: () => Promise<void>;
  /** The pause before the next read, asked again every time one is armed (a mission that went live reads faster). */
  nextDelayMs: () => number;
  /** The longest a read is waited for before the next one is armed (default 20 seconds). */
  readTimeoutMs?: number;
  /** Asked after every read: false ends the loop after that read (a panel that reads once more when its mission ends). Default: go on. */
  keepGoing?: () => boolean;
}

export const MISSION_READ_LIMIT_MS = 20_000;

/** Starts the loop (the first read is made at once); returns the function that stops it. */
export function startMissionPolling(o: MissionPollingOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const limit = o.readTimeoutMs ?? MISSION_READ_LIMIT_MS;
  const once = async (): Promise<void> => {
    if (stopped) return;
    let limitTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.resolve().then(o.read),
        new Promise<void>((resolve) => { limitTimer = setTimeout(resolve, limit); }),
      ]);
    } catch { /* the loop keeps going: the card keeps what it has */ } finally {
      if (limitTimer) clearTimeout(limitTimer);
    }
    if (stopped) return;
    if (o.keepGoing && !o.keepGoing()) return;
    timer = setTimeout(() => { void once(); }, Math.max(0, o.nextDelayMs()));
  };
  void once();
  return () => { stopped = true; if (timer) clearTimeout(timer); timer = null; };
}
