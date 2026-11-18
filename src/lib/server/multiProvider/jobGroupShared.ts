export const TIMED_OUT: unique symbol = Symbol("TIMED_OUT");

export function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(TIMED_OUT);
      }
    }, ms);

    Promise.resolve(p).then(
      (val) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(val);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    );
  });
}

export function isMissingSchema(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  const code = String(e?.code || "");
  const msg = String(e?.message || "");
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    code === "PGRST202" ||
    code === "42883" ||
    /does not exist|schema cache|could not find the (table|function)/i.test(msg)
  );
}

export function frozenPathFor(userId: string, jobId: string, sha256: string): string {
  return `${userId}/${jobId}/frozen-${sha256}.json`;
}

export function servedPathFor(userId: string, jobId: string, sha256: string, format: string): string {
  return `${userId}/${jobId}/served-${sha256}.${format}`;
}
