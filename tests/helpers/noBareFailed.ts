import { expect } from "vitest";
import { toArabicDigits } from "../../src/lib/arabicDigits";
import { normalizeReleaseWording } from "../../src/lib/releaseWording";

/** DT-20261117-06 T-M helper: what a customer can read after a worker run, and the no-bare-failure checks over it. Pure apart from `expect`. */

/** Every `p_error_message` of the release and retry calls, every event message, every string job error text and the route's `error`, each read the way the screens read it (normalizeReleaseWording). */
export function customerTexts(x: { rpcCalls: Array<{ name: string; args: any }>; events: Array<{ message?: unknown }>; jobs: Array<{ error_message?: unknown }>; json: any }): string[] {
  const out: string[] = [];
  for (const call of x.rpcCalls) {
    if ((call.name === "release_job_atomic" || call.name === "record_chunk_failure") && typeof call.args?.p_error_message === "string") out.push(call.args.p_error_message);
  }
  for (const event of x.events) if (typeof event.message === "string") out.push(event.message);
  for (const job of x.jobs) if (typeof job.error_message === "string") out.push(job.error_message);
  if (typeof x.json?.error === "string") out.push(x.json.error);
  return out.map((text) => normalizeReleaseWording(text));
}

/** No text contains «فشل» or a Latin letter. */
export function expectNoBareFailed(texts: string[]): void {
  for (const t of texts) expect(t, t).not.toMatch(/فشل|[A-Za-z]/);
}

/** The stored text of a released job starts «المسلَّم ٠ من N مطلوب.». */
export function expectReleasedZeroOf(stored: unknown, n: number): void {
  expect(String(stored).startsWith(`المسلَّم ${toArabicDigits(0)} من ${toArabicDigits(n)} مطلوب.`)).toBe(true);
}
