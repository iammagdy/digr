/**
 * The platform kills a function at its time limit and the browser then sees a dropped connection. Answering a few seconds
 * earlier, with a coded error, lets the page show one Arabic sentence and a retry button instead.
 */
export class DeadlineExceededError extends Error {
  readonly reasonCode = "deadline_exceeded";
  readonly statusCode = 504;
  constructor(readonly label: string, readonly ms: number) {
    super(`${label} exceeded ${ms}ms`);
    this.name = "DeadlineExceededError";
  }
}

export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(label, ms)), ms);
  });
  // The work may still finish after the deadline: its late result or failure must not become an unhandled rejection.
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => { if (timer) clearTimeout(timer); });
}
