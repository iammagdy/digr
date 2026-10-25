import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/server/sendPlatformEmail", async (original) => ({
  ...(await original<any>()),
  getRecipient: vi.fn(async (_admin: any, userId: string) => (userId === "optout" ? null : { email: `${userId}@example.com`, name: "سلمى" })),
  sendPlatformEmail: vi.fn(async (template: string, to: string, vars: Record<string, string>, key?: string) => { mailbox.push({ template, to, vars, key }); return { ok: true }; }),
}));
const mailbox: Array<{ template: string; to: string; vars: Record<string, string>; key?: string }> = [];

import PlanQuoteCard from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { GET as driverStatus } from "../src/app/api/driver-status/route";
import { closePageLineAr, normalizeDriverMode } from "../src/lib/driverMode";
import { MIN_CHUNKS_FOR_ETA, chunkMarksFromEvents, computeJobProgress, type ChunkMark } from "../src/lib/jobProgress";
import { STALLED_LINE_AR, STALL_AFTER_MS, idleMs, isJobStalled } from "../src/lib/jobStall";
import { missionDurationForPlan } from "../src/lib/missionDuration";
import {
  JOB_NOTICES_PER_JOB_LIMIT,
  completionNoticeFull,
  jobNoticeEmailKey,
  jobNoticeId,
  releasedNoticeFull,
  sendJobNotice,
  startedNoticeFull,
  stalledNoticeFull,
  type JobNoticeFull,
} from "../src/lib/server/jobNotices";
import { MAX_STALLED_NOTICES_PER_CALL, notifyStalledJobs } from "../src/lib/server/jobStallNotifier";
import { REFUND_AFTER_MS, buildOperationsSnapshot } from "../src/lib/server/adminOperations";
import { PLATFORM_EMAIL_SUBJECTS, renderEmailTemplate } from "../supabase/functions/send-email/templates";

const T0 = Date.parse("2026-10-20T10:00:00Z");
const marksEvery = (gapSeconds: number, count: number, unitsPerChunk: number, start = 0): ChunkMark[] =>
  Array.from({ length: count }, (_, i) => ({ at: T0 + (start + (i + 1) * gapSeconds) * 1000, units: (i + 1) * unitsPerChunk }));
const CLEAN = /^(?![\s\S]*(?:[A-Za-z0-9]|undefined|null|NaN|USD|\$|treg|tikhub|scrapecreators|crawl4ai|endpoint|https?:))[\s\S]*$/u;

describe("live progress from the real chunks", () => {
  it("«تم ١٢٬٠٠٠ من ٥٠٬٠٠٠ · المتبقي …» from a steady pace", () => {
    const marks = marksEvery(20, 8, 50);
    const progress = computeJobProgress({ delivered: 12000, target: 50000, marks });
    expect(progress.lineAr.startsWith("تم ١٢٬٠٠٠ من ٥٠٬٠٠٠ · المتبقي ")).toBe(true);
    expect(progress.remainingAr).toBeTruthy();
    expect(progress.chunksSeen).toBe(7);
    // 38,000 left at 50 a chunk, 20 s a chunk: 760 chunks, about 4 hours
    expect(progress.optimisticSeconds!).toBeGreaterThan(14000);
    expect(progress.optimisticSeconds!).toBeLessThan(16000);
    expect(progress.lineAr).toMatch(CLEAN);
  });

  it("says nothing made-up before a few chunks have run, and nothing when a chunk delivered nothing", () => {
    expect(MIN_CHUNKS_FOR_ETA).toBe(3);
    const few = computeJobProgress({ delivered: 100, target: 1000, marks: marksEvery(20, 3, 50) });
    expect(few.remainingAr).toBeNull();
    expect(few.lineAr).toBe("تم ١٠٠ من ١٬٠٠٠ · نحسب الوقت المتبقي بعد بضع دفعات");
    const none = computeJobProgress({ delivered: 0, target: 1000, marks: marksEvery(20, 8, 0) });
    expect(none.remainingAr).toBeNull();
    const enough = computeJobProgress({ delivered: 100, target: 1000, marks: marksEvery(20, 4, 50) });
    expect(enough.remainingAr).not.toBeNull();
  });

  it("is recomputed at every chunk: one more chunk, a different line", () => {
    const base = marksEvery(20, 6, 50);
    const first = computeJobProgress({ delivered: 300, target: 3000, marks: base });
    const next = computeJobProgress({ delivered: 350, target: 3000, marks: [...base, { at: base[5].at + 20_000, units: 350 }] });
    expect(next.lineAr).not.toBe(first.lineAr);
    expect(next.optimisticSeconds!).toBeLessThan(first.optimisticSeconds!);
  });

  it("widens honestly when the provider slows down, and when the job is waiting to retry", () => {
    const steady = marksEvery(10, 9, 50);
    const slowing: ChunkMark[] = [];
    let at = 0;
    let units = 0;
    for (const gap of [10, 10, 10, 10, 10, 10, 30, 30, 30]) { at += gap; units += 50; slowing.push({ at: T0 + at * 1000, units }); }
    const a = computeJobProgress({ delivered: 450, target: 5000, marks: steady });
    const b = computeJobProgress({ delivered: 450, target: 5000, marks: slowing });
    expect(a.widened).toBe(false);
    expect(b.widened).toBe(true);
    expect(b.pessimisticSeconds!).toBeGreaterThan(a.pessimisticSeconds!);
    const retrying = computeJobProgress({ delivered: 450, target: 5000, marks: steady, retrying: true });
    expect(retrying.widened).toBe(true);
    expect(retrying.pessimisticSeconds!).toBeGreaterThan(a.pessimisticSeconds!);
    expect(retrying.remainingAr).toMatch(/^من /u);
  });

  it("a gap of a closed page or a stall is not the cost of a chunk", () => {
    const marks = [...marksEvery(20, 5, 50), { at: T0 + 5 * 3600 * 1000, units: 300 }, { at: T0 + 5 * 3600 * 1000 + 20_000, units: 350 }];
    const progress = computeJobProgress({ delivered: 350, target: 1000, marks });
    expect(progress.pessimisticSeconds!).toBeLessThan(3600);
  });

  it("a finished collection says the files are being built; Arabic digits only", () => {
    const done = computeJobProgress({ delivered: 1000, target: 1000, marks: marksEvery(20, 8, 125) });
    expect(done.lineAr).toBe("تم ١٬٠٠٠ من ١٬٠٠٠ · اكتمل الجمع، وجارٍ تجهيز الملفات");
    expect(done.lineAr).toMatch(CLEAN);
  });

  it("chunk marks come only from the «الصفحة» lines", () => {
    const rows: any[] = [
      { message: "الصفحة ١: استلمنا ٥٠ سجل · الجديد ٥٠ · الإجمالي ٥٠", units: 50, created_at: "2026-10-20T10:00:20Z" },
      { message: "جاري تجهيز ملفات النتائج وتنسيقها...", units: 50, created_at: "2026-10-20T10:00:25Z" },
      { message: "الصفحة ٢: استلمنا ٥٠ سجل", units: 100, created_at: "2026-10-20T10:00:40Z" },
      { message: "الصفحة ٣", units: "x", created_at: "2026-10-20T10:01:00Z" },
    ];
    expect(chunkMarksFromEvents(rows).map((m) => m.units)).toEqual([50, 100]);
  });

  it("the chat page and the requests page both show it, from the real chunk lines", () => {
    const chat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    const requests = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    for (const page of [chat, requests]) {
      expect(page).toContain("chunkMarksFromEvents(");
      expect(page).toContain("computeJobProgress(");
    }
    expect(chat).toContain('data-testid="job-progress"');
    expect(requests).toContain('data-testid="request-progress"');
    expect(requests).toContain('.like("message", "الصفحة%")');
  });
});

describe("stall handling", () => {
  const now = T0 + 3600_000;
  const row = (extra: Record<string, any> = {}) => ({ status: "running", updated_at: new Date(now - STALL_AFTER_MS).toISOString(), lease_until: null, ...extra });

  it("N is ten minutes, and the sentence is exact", () => {
    expect(STALL_AFTER_MS).toBe(10 * 60 * 1000);
    expect(STALLED_LINE_AR).toBe("المهمة متوقفة مؤقتًا، ولن يُخصم أكثر من المُسلَّم.");
    expect(STALLED_LINE_AR).toMatch(CLEAN);
  });

  it("stalled = queued or running, no live lease, no progress for N minutes", () => {
    expect(isJobStalled(row(), now)).toBe(true);
    expect(isJobStalled(row({ status: "queued" }), now)).toBe(true);
    expect(isJobStalled(row({ updated_at: new Date(now - STALL_AFTER_MS + 1000).toISOString() }), now)).toBe(false);
    expect(isJobStalled(row({ lease_until: new Date(now + 20_000).toISOString() }), now)).toBe(false);
    expect(isJobStalled(row({ lease_until: new Date(now - 20_000).toISOString() }), now)).toBe(true);
    for (const status of ["completed", "failed", "refused", "done", undefined]) expect(isJobStalled(row({ status }), now)).toBe(false);
    expect(isJobStalled({ status: "running" }, now)).toBe(false);
    expect(idleMs(row(), now)).toBe(STALL_AFTER_MS);
  });

  it("the admin operations panel flags it, with the time left before the existing refund", () => {
    const snapshot = buildOperationsSnapshot({
      now,
      jobs: [
        { id: "a", status: "running", lease_until: null, updated_at: new Date(now - 4 * 60_000).toISOString(), created_at: null },
        { id: "b", status: "running", lease_until: null, updated_at: new Date(now - 12 * 60_000).toISOString(), created_at: null },
      ],
      provider: { todaySpendUsd: 0, todayCapUsd: 1, availableBalanceUsd: 5, creditUsd: 1, warnPercent: 80 },
    });
    expect(snapshot.stalled.map((job) => [job.id, job.customerSeesStalled])).toEqual([["a", false], ["b", true]]);
    expect(snapshot.stalled[1].refundInMinutes).toBe(Math.ceil((REFUND_AFTER_MS - 12 * 60_000) / 60_000));
    expect(snapshot.alerts[0].textAr).toContain("يظهر لعميله الآن «متوقف مؤقتًا»");
  });

  it("the notifier tells the customer once per job and moves nothing", async () => {
    const inserted: any[] = [];
    const jobs = [
      { id: "j1", user_id: "u1", status: "running", updated_at: new Date(now - 15 * 60_000).toISOString(), lease_until: null },
      { id: "j2", user_id: "u2", status: "running", updated_at: new Date(now - 15 * 60_000).toISOString(), lease_until: new Date(now + 30_000).toISOString() },
      { id: "j3", user_id: "optout", status: "queued", updated_at: new Date(now - 11 * 60_000).toISOString(), lease_until: null },
    ];
    const seen = new Set<string>();
    const admin: any = {
      calls: [] as string[],
      from(table: string) {
        const api: any = {};
        for (const m of ["select", "in", "lt", "order", "eq", "like"]) api[m] = () => api;
        api.limit = async () => ({ data: table === "jobs" ? jobs : [], error: null });
        api.then = (resolve: any) => resolve({ count: 0, data: [], error: null });
        api.insert = async (row: any) => {
          admin.calls.push(`insert:${table}`);
          if (table === "notifications") { if (seen.has(row.id)) return { error: { code: "23505" } }; seen.add(row.id); inserted.push(row); }
          return { error: null };
        };
        return api;
      },
    };
    mailbox.length = 0;
    expect(await notifyStalledJobs(admin, now)).toEqual({ considered: 2, notified: 2 });
    expect(inserted.map((row) => row.id)).toEqual([jobNoticeId("stalled", "j1"), jobNoticeId("stalled", "j3")]);
    expect(inserted[0].body).toContain(STALLED_LINE_AR);
    expect(mailbox.map((m) => [m.template, m.to, m.key])).toEqual([["job-update", "u1@example.com", jobNoticeEmailKey("stalled", "j1")]]);
    // asked again: the same notices are no-ops
    expect(await notifyStalledJobs(admin, now)).toEqual({ considered: 2, notified: 0 });
    expect(mailbox).toHaveLength(1);
    expect(admin.calls.every((call: string) => call === "insert:notifications")).toBe(true);
    expect(MAX_STALLED_NOTICES_PER_CALL).toBe(20);
    expect(readFileSync("src/lib/server/jobStallNotifier.ts", "utf8")).not.toMatch(/\.rpc\(|release_job|settle_job|credit_ledger|\.update\(|\.delete\(/);
  });

  it("the pages show the stalled line only for a stalled job", () => {
    for (const file of ["src/app/dashboard/chat/page.tsx", "src/app/dashboard/requests/page.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("isJobStalled(");
      expect(source).toContain("STALLED_LINE_AR");
    }
  });
});

describe("the notices of a job", () => {
  it("every notice is plain Arabic: Arabic digits, no provider, endpoint, link, id or money in dollars", () => {
    const all: JobNoticeFull[] = [
      startedNoticeFull({ targetVolumeMax: 1500, driver: "cron" }),
      startedNoticeFull({ targetVolumeMax: 1500, driver: "tab" }),
      stalledNoticeFull(),
      completionNoticeFull({ delivered: 100, requested: 100, chargedPoints: 900, refundedPoints: 50 }),
      completionNoticeFull({ delivered: 40, requested: 100, chargedPoints: 360, refundedPoints: 540 }),
      releasedNoticeFull(590),
      releasedNoticeFull(0),
    ];
    for (const notice of all) {
      for (const text of [notice.title, notice.body, ...(notice.email ? Object.values(notice.email) : [])]) {
        expect(text, text).toMatch(CLEAN);
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      }
      expect(notice.link.startsWith("/dashboard/")).toBe(true);
    }
  });

  it("a partial completion says what was delivered and what was charged and returned, in plain Arabic", () => {
    const notice = completionNoticeFull({ delivered: 40, requested: 100, chargedPoints: 360, refundedPoints: 540 });
    expect(notice.kind).toBe("partial");
    expect(notice.title).toBe("اكتمل طلبك جزئيًا");
    expect(notice.body).toContain("تم تسليم ٤٠ من ١٠٠ سجلاً");
    expect(notice.body).toContain("خُصم ٣٦٠ نقطة مقابل ما سُلّم فقط");
    expect(notice.body).toContain("حجز مؤقت مُحرَّر ٥٤٠ نقطة");
    expect(notice.email?.subject).toBe("اكتمل طلبك جزئيًا");
    const full = completionNoticeFull({ delivered: 100, requested: 100, chargedPoints: 900, refundedPoints: 0 });
    expect(full.kind).toBe("completed");
    expect(full.title).toBe("اكتمل طلب استخراج البيانات بنجاح");
    expect(full.email).toBeNull();
  });

  it("a release says the whole reserve came back with no charge", () => {
    const notice = releasedNoticeFull(590);
    expect(notice.kind).toBe("released");
    expect(notice.body).toContain("حجز مؤقت مُحرَّر ٥٩٠ نقطة كاملًا دون أي خصم");
  });

  it("the start notice says «you can close the page» only with the always-on driver", () => {
    expect(startedNoticeFull({ targetVolumeMax: 800, driver: "cron" }).body).toContain("يمكنك إغلاق الصفحة");
    expect(startedNoticeFull({ targetVolumeMax: 800, driver: "tab" }).body).not.toContain("يمكنك إغلاق الصفحة");
    expect(startedNoticeFull({ targetVolumeMax: 800 }).body).not.toContain("يمكنك إغلاق الصفحة");
  });

  describe("sending", () => {
    const makeAdmin = (existing = 0) => {
      const rows = new Map<string, any>();
      const admin: any = {
        rows,
        from(table: string) {
          const api: any = {};
          for (const m of ["select", "eq", "like", "in"]) api[m] = () => api;
          api.then = (resolve: any) => resolve({ count: existing + rows.size, data: [], error: null });
          api.insert = async (row: any) => {
            if (table !== "notifications") return { error: null };
            if (rows.has(row.id)) return { error: { code: "23505" } };
            rows.set(row.id, row);
            return { error: null };
          };
          return api;
        },
      };
      return admin;
    };

    it("each kind is sent once per job; the e-mail goes only with a new in-app row and uses an idempotency key", async () => {
      mailbox.length = 0;
      const admin = makeAdmin();
      const partial = completionNoticeFull({ delivered: 40, requested: 100, chargedPoints: 360, refundedPoints: 540 });
      expect(await sendJobNotice(admin, "u1", "job_1", partial)).toEqual({ inApp: true, email: true });
      expect(await sendJobNotice(admin, "u1", "job_1", partial)).toEqual({ inApp: false, email: false });
      expect(mailbox).toHaveLength(1);
      expect(mailbox[0]).toMatchObject({ template: "job-update", to: "u1@example.com", key: "job-update:partial:job_1" });
      expect(mailbox[0].vars).toMatchObject({ Subject: "اكتمل طلبك جزئيًا", Heading: "اكتمل طلبك جزئيًا", ButtonLabel: "تحميل الملفات" });
      expect(mailbox[0].vars.JobURL).toContain("/dashboard/requests?job=job_1");
      expect([...admin.rows.keys()]).toEqual(["notif_partial_job_1"]);
    });

    it("a completion in full and a release are in-app only (they have their own e-mails)", async () => {
      mailbox.length = 0;
      const admin = makeAdmin();
      expect((await sendJobNotice(admin, "u1", "job_2", completionNoticeFull({ delivered: 10, requested: 10, chargedPoints: 90, refundedPoints: 0 }))).email).toBe(false);
      expect((await sendJobNotice(admin, "u1", "job_2", releasedNoticeFull(100))).email).toBe(false);
      expect(mailbox).toHaveLength(0);
    });

    it("never more than four notices per job, and a customer who opted out gets the in-app notice only", async () => {
      mailbox.length = 0;
      expect(JOB_NOTICES_PER_JOB_LIMIT).toBe(4);
      const full = makeAdmin(JOB_NOTICES_PER_JOB_LIMIT);
      expect(await sendJobNotice(full, "u1", "job_3", stalledNoticeFull())).toEqual({ inApp: false, email: false });
      const optedOut = makeAdmin();
      expect(await sendJobNotice(optedOut, "optout", "job_4", stalledNoticeFull())).toEqual({ inApp: true, email: false });
    });

    it("a job gets at most started, stalled and one terminal notice: three kinds, one id each", async () => {
      mailbox.length = 0;
      const admin = makeAdmin();
      for (const notice of [startedNoticeFull({ targetVolumeMax: 500, driver: "cron" }), stalledNoticeFull(), completionNoticeFull({ delivered: 1, requested: 5, chargedPoints: 9, refundedPoints: 36 })]) {
        await sendJobNotice(admin, "u1", "job_5", notice);
        await sendJobNotice(admin, "u1", "job_5", notice);
      }
      expect(admin.rows.size).toBe(3);
      expect(admin.rows.size).toBeLessThanOrEqual(JOB_NOTICES_PER_JOB_LIMIT);
    });

    it("never throws, whatever the database does", async () => {
      expect(await sendJobNotice({ from: () => { throw new Error("down"); } }, "u1", "job_6", stalledNoticeFull())).toEqual({ inApp: false, email: false });
      expect(await sendJobNotice(makeAdmin(), "", "job_6", stalledNoticeFull())).toEqual({ inApp: false, email: false });
    });

    it("the worker sends the completion and release notices through it, after the settlement", () => {
      const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
      expect(worker).toContain("completionNoticeFull(completionFacts)");
      expect(worker).toContain("releasedNoticeFull(");
      expect(worker.indexOf("completionNoticeFull(completionFacts)")).toBeGreaterThan(worker.indexOf('"settle_job_atomic"'));
    });
  });
});

describe("the e-mail template, in isolation", () => {
  const vars = { Name: "سلمى", Subject: "اكتمل طلبك جزئيًا", Heading: "اكتمل طلبك جزئيًا", Lead: "وصلك ٤٠ من ١٠٠ مطلوب.", DetailOne: "خُصم ٣٦٠ نقطة مقابل ما سُلّم فقط.", DetailTwo: "وعادت ٥٤٠ نقطة إلى رصيدك.", ButtonLabel: "تحميل الملفات", JobURL: "https://diger.tech/dashboard/requests?job=job_1" };

  it("renders with no leftover token, the subject from the caller, the logo and the link", () => {
    const { subject, html } = renderEmailTemplate("job-update", vars);
    expect(subject).toBe("اكتمل طلبك جزئيًا");
    expect(html).not.toContain("{{");
    expect(html).toContain("https://diger.tech/email/digr-wordmark.png");
    expect(html).toContain("وصلك ٤٠ من ١٠٠ مطلوب.");
    expect(html).toContain('href="https://diger.tech/dashboard/requests?job=job_1"');
    expect(html).toContain('dir="rtl"');
  });

  it("escapes values and renders a missing one as empty, never as a token", () => {
    const { html, subject } = renderEmailTemplate("job-update", { ...vars, Lead: "<script>alert(1)</script>", DetailTwo: undefined as any });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("{{");
    expect(subject).not.toContain("{{");
  });

  it("every template of the Edge Function still renders (the six approved ones, job-update and the admin alert)", () => {
    expect(Object.keys(PLATFORM_EMAIL_SUBJECTS).sort()).toEqual(["admin-topup-alert", "job-done", "job-update", "refund", "topup-approved", "topup-received", "topup-rejected", "welcome"]);
    for (const id of Object.keys(PLATFORM_EMAIL_SUBJECTS) as Array<keyof typeof PLATFORM_EMAIL_SUBJECTS>) {
      const { subject, html } = renderEmailTemplate(id, { Name: "سلمى" });
      expect(subject).not.toContain("{{");
      expect(html).not.toContain("{{");
    }
  });

  it("the Edge Function accepts it, and the app can send it", () => {
    expect(readFileSync("supabase/functions/send-email/index.ts", "utf8")).toContain('"job-update"');
    expect(readFileSync("src/lib/server/sendPlatformEmail.ts", "utf8")).toContain('"job-update"');
  });
});

describe("«you can close the page» only with the always-on driver", () => {
  it("the line for each state", () => {
    expect(closePageLineAr("cron")).toBe("تقدر تقفل الصفحة؛ المهمة تكمل وحدها وسنبلغك عند الاكتمال.");
    expect(closePageLineAr("tab")).toBe("أبقِ الصفحة مفتوحة حتى تكتمل المهمة.");
    expect(closePageLineAr("tab")).not.toContain("تقفل");
    expect(normalizeDriverMode(undefined)).toBe("tab");
    expect(normalizeDriverMode("cron")).toBe("cron");
    expect(normalizeDriverMode("true")).toBe("tab");
  });

  it("the plan panel says it from the flag: not for «tab», yes for «cron»", () => {
    const items = [{ capabilitySlug: "social-youtube-comments", targetVolumeMax: 500, params: { query: "x" } }];
    const tab = missionDurationForPlan(items, "tab")!;
    const cron = missionDurationForPlan(items, "cron")!;
    expect(tab.closePageAr).toBe(closePageLineAr("tab"));
    expect(cron.closePageAr).toBe(closePageLineAr("cron"));
    const render = (duration: any) => renderToStaticMarkup(createElement(PlanQuoteCard, {
      quote: { quoteId: "q", summaryAr: "x", items: [], targetVolumeMax: 500, unitPricePoints: 9, quotedPoints: 590, isAffordable: true, userBalance: 5000, outputFormats: ["xlsx"], expiresAt: new Date(Date.now() + 3600_000).toISOString(), status: "quoted", duration },
      onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {},
    } as any));
    expect(render(tab)).not.toContain("تقدر تقفل الصفحة");
    expect(render(tab)).toContain("أبقِ الصفحة مفتوحة");
    expect(render(cron)).toContain("تقدر تقفل الصفحة");
  });

  it("the driver-status endpoint reports the flag and defaults to «tab»", async () => {
    const original = process.env.LONG_JOB_DRIVER;
    try {
      delete process.env.LONG_JOB_DRIVER;
      expect(await (await driverStatus()).json()).toEqual({ mode: "tab" });
      process.env.LONG_JOB_DRIVER = "cron";
      expect(await (await driverStatus()).json()).toEqual({ mode: "cron" });
      process.env.LONG_JOB_DRIVER = "banana";
      expect(await (await driverStatus()).json()).toEqual({ mode: "tab" });
    } finally {
      if (original === undefined) delete process.env.LONG_JOB_DRIVER; else process.env.LONG_JOB_DRIVER = original;
    }
  });

  it("the chat page shows the line from the flag read from the server, and the approval answer carries it", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("closePageLineAr(driverMode)");
    expect(page).toContain("useDriverMode()");
    expect(page).not.toContain("تقدر تقفل الصفحة");
    expect(readFileSync("src/app/api/chat/accept-quote/route.ts", "utf8")).toContain("driverMode: longJobDriverMode()");
    expect(readFileSync("src/hooks/useDriverMode.ts", "utf8")).toContain('useState<DriverMode>(cached ?? "tab")');
  });
});
