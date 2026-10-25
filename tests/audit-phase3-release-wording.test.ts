import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAQS } from "../src/components/landing/landingFaq";
import { OVERVIEW_PAYMENT_AR } from "../src/components/landing/Overview";
import { completionNoticeFull, jobStalledNotice, releasedNoticeFull, jobStartedNotice } from "../src/lib/server/jobNotices";
import { normalizeReleaseWording } from "../src/lib/releaseWording";
import { PRICING_FAQ_AR } from "../src/lib/pricingPage";
import { FAILURE_STATE_AR } from "../src/lib/publicCopy";
import { WORKER_START_FINAL_REASON_AR } from "../src/lib/server/workerStartFailure";

const RELEASED = "حجز مؤقت مُحرَّر";
/** A released hold said as a refund: the words the owner banned for customer-facing money text. */
const REFUND_STYLE = /يُرد إلى|وعادت [^.]*إلى رصيدك|استرداد|إرجاع (?:ال)?(?:نقاط|رصيد)|إرجاع كامل|أُعيدت (?:ال)?نقاط|أعدنا (?:\S+ )?(?:نقاط|[٠-٩]+ نقطة)|يعود إليك|تعود إليك|تعود نقاطك|يعود إلى رصيدك|يعود كل ما|إلى رصيدك المتاح/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe("audit phase 3: a released hold is «حجز مؤقت مُحرَّر», never a refund", () => {
  it("no customer-facing source says it the refund way (the account-deletion line, the legal text and the normalizer itself are the only exceptions)", () => {
    const allowed = [/dashboard\/settings\/page\.tsx$/, /lib\/legalText\.ts$/, /lib\/releaseWording\.ts$/, /lib\/walletText\.ts$/, /admin\//];
    const hits: string[] = [];
    for (const file of walk("src")) {
      if (allowed.some((pattern) => pattern.test(file))) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        if (REFUND_STYLE.test(line)) hits.push(`${file}:${index + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the completion, stall, start and release notices use the released-hold wording", () => {
    const partial = completionNoticeFull({ requested: 100, delivered: 40, chargedPoints: 360, refundedPoints: 540 } as never);
    expect(partial.body).toContain(`${RELEASED} ٥٤٠ نقطة`);
    expect(partial.body).not.toMatch(REFUND_STYLE);
    expect(partial.email?.detail2).toContain(RELEASED);
    expect(jobStalledNotice().title).toBe(`توقف طلبك: ${RELEASED}`);
    expect(jobStalledNotice().body).toContain(RELEASED);
    const released = releasedNoticeFull(590, { withEmail: true });
    expect(released.title).toBe(`تعذّر تنفيذ طلبك: ${RELEASED}`);
    expect(released.body).toContain(`${RELEASED} ٥٩٠ نقطة كاملًا دون أي خصم`);
    expect(released.email?.detail1).toContain(RELEASED);
    for (const driver of ["tab", "cron"] as const) {
      const started = jobStartedNotice({ targetVolumeMax: 1500, driver });
      expect(started.body).toContain(RELEASED);
      expect(started.body).not.toMatch(REFUND_STYLE);
    }
  });

  it("the public failure line, the pricing FAQ and the landing FAQ say the same thing", () => {
    expect(FAILURE_STATE_AR).toContain(RELEASED);
    expect(WORKER_START_FINAL_REASON_AR).toContain(RELEASED);
    for (const [, answer] of PRICING_FAQ_AR) expect(answer).not.toMatch(REFUND_STYLE);
    expect(readFileSync("src/components/landing/data.ts", "utf8")).not.toContain("يُرد");
    for (const [, answer] of FAQS) expect(answer).not.toMatch(REFUND_STYLE);
    expect(FAQS[0][1]).toBe(PRICING_FAQ_AR[0][1]);
    expect(FAQS[2][1]).toBe(PRICING_FAQ_AR[1][1]);
    expect(OVERVIEW_PAYMENT_AR).toContain("حجز مؤقت مُحرَّر");
  });

  it("notices stored BEFORE this rule are read through the normalizer, so an old bell row shows the new wording", () => {
    expect(normalizeReleaseWording("توقف طلبك وأعدنا نقاطك")).toBe(`توقف طلبك: ${RELEASED}`);
    expect(normalizeReleaseWording("فأعدنا نقاطك المحجوزة كاملة لرصيدك دون أي خصم")).toBe(`${RELEASED} كاملًا دون أي خصم`);
    expect(normalizeReleaseWording("أعدنا ٣٠ نقطة محجوزة كاملة إلى رصيدك دون أي خصم.")).toBe(`${RELEASED} ٣٠ نقطة كاملًا دون أي خصم.`);
    expect(normalizeReleaseWording("خُصم ١٠٠ نقطة. وعادت ٤٨ نقطة إلى رصيدك.")).toBe(`خُصم ١٠٠ نقطة. وحجز مؤقت مُحرَّر ٤٨ نقطة.`);
    expect(normalizeReleaseWording("وإذا تعذر استكماله تعود نقاطك المحجوزة كاملة.")).toBe(`وإذا تعذر استكماله فهو ${RELEASED} كاملًا.`);
    expect(readFileSync("src/components/app/AppShell.tsx", "utf8")).toContain("normalizeReleaseWording(n.body)");
  });
});
