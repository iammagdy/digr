/**
 * VERCEL ACTIVE CPU (docs/ops/VERCEL-CPU.md): a page's timed refresh that asks the server ONLY while the tab is visible.
 *
 * Every tick of an admin page's timer is a function invocation (authentication, database reads, JSON), and an admin tab left open in the background
 * used to keep asking every few seconds all day. With this helper a hidden tab asks nothing; when the tab becomes visible again it asks ONCE at
 * once (so the screen is never stale when someone looks at it), then on the usual interval. What each tick reads and shows is unchanged.
 *
 * `delayMs` is read before every wait, so a caller can slow down (e.g. a mission that has ended) without restarting the loop. Returns `stop`.
 * The document is injectable for tests; without a document (server render) nothing is scheduled.
 */
export interface VisibilityDoc {
  visibilityState: string;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

export function startVisiblePolling(tick: () => void, delayMs: number | (() => number), doc: VisibilityDoc | null = typeof document === "undefined" ? null : document): () => void {
  if (!doc) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const visible = () => doc.visibilityState !== "hidden";
  const wait = () => (typeof delayMs === "function" ? delayMs() : delayMs);
  const schedule = () => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    // a hidden tab schedules nothing at all: the next ask is the one visibilitychange makes
    if (!visible()) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped || !visible()) return;
      tick();
      schedule();
    }, wait());
  };
  const onVisibility = () => {
    if (stopped) return;
    if (visible()) { tick(); schedule(); } else if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  doc.addEventListener("visibilitychange", onVisibility);
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
