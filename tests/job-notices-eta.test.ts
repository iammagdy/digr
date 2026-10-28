import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ETA_MIN_SPAN_MS, ETA_WINDOW_MS, estimateRemainingSeconds, etaTextAr } from "../src/lib/jobEta";
import { LONG_JOB_MIN_UNITS, insertJobNotice, isLongJob, jobStalledNotice, jobStartedNotice } from "../src/lib/server/jobNotices";

describe("the remaining time comes from the job's real pace", () => {
  const NOW = 1_000_000_000_000;
  const s = (secondsAgo: number, delivered: number) => ({ at: NOW - secondsAgo * 1000, delivered });

  it("is the rows left divided by the pace seen between the first and last sample", () => {
    // 50 records in 60 s = 0.833/s; 150 left of 200 => 180 s
    expect(estimateRemainingSeconds([s(60, 0), s(0, 50)], 200, NOW)).toBe(180);
    // pace from the whole window, not just the last two points
    expect(estimateRemainingSeconds([s(120, 0), s(60, 50), s(0, 100)], 200, NOW)).toBe(120);
  });

  it("is zero when everything arrived, and never negative", () => {
    expect(estimateRemainingSeconds([s(60, 0), s(0, 200)], 200, NOW)).toBe(0);
    expect(estimateRemainingSeconds([s(60, 0), s(0, 250)], 200, NOW)).toBe(0);
  });

  it("is nothing (never a guess) with one sample, no progress, a span that is too short, or no target", () => {
    expect(estimateRemainingSeconds([s(0, 10)], 100, NOW)).toBeNull();
    expect(estimateRemainingSeconds([s(60, 10), s(0, 10)], 100, NOW)).toBeNull();
    expect(estimateRemainingSeconds([s(5, 0), s(0, 50)], 100, NOW)).toBeNull();
    expect(ETA_MIN_SPAN_MS).toBe(20_000);
    expect(estimateRemainingSeconds([s(60, 0), s(0, 50)], 0, NOW)).toBeNull();
    expect(estimateRemainingSeconds([], 100, NOW)).toBeNull();
  });

  it("ignores samples older than the window (a pace that no longer holds)", () => {
    expect(ETA_WINDOW_MS).toBe(600_000);
    expect(estimateRemainingSeconds([s(3000, 0), s(2990, 5)], 100, NOW)).toBeNull();
    expect(estimateRemainingSeconds([s(3000, 0), s(60, 50), s(0, 100)], 200, NOW)).toBe(120); // the 3000 s old sample is ignored: 50 records per 60 s, 100 left
  });

  it("is written in calm Arabic units with Arabic digits, and nothing when unknown", () => {
    expect(etaTextAr(null)).toBeNull();
    expect(etaTextAr(-5)).toBeNull();
    expect(etaTextAr(30)).toBe("أقل من دقيقة");
    expect(etaTextAr(61)).toBe("حوالي دقيقتين");
    expect(etaTextAr(300)).toBe("حوالي ٥ دقائق");
    expect(etaTextAr(660)).toBe("حوالي ١١ دقيقة");
    expect(etaTextAr(5400)).toBe("حوالي ساعتين");
    expect(etaTextAr(3 * 3600)).toBe("حوالي ٣ ساعات");
    for (const seconds of [30, 61, 300, 660, 5400, 11000]) expect(etaTextAr(seconds)).not.toMatch(/[A-Za-z0-9]/);
  });

  it("the page computes the remaining time from the real chunk lines of the job and shows it only when there is one", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("chunkMarksFromEvents(");
    expect(page).toContain("computeJobProgress(");
    expect(page).toContain('data-testid="job-progress"');
    expect(page).toContain("تقديري ويتحدث مع كل دفعة");
    // shown only while a chunk-based estimate exists; with too few chunks the line says it will be computed later, never a made-up time
    expect(page).toContain("progress.remainingAr ?");
    expect(page).not.toContain("progressSamples");
  });
});

describe("the notices of a long job", () => {
  it("a job is long from 200 records", () => {
    expect(LONG_JOB_MIN_UNITS).toBe(200);
    expect(isLongJob(199)).toBe(false);
    expect(isLongJob(200)).toBe(true);
    expect(isLongJob(Number.NaN)).toBe(false);
  });

  it("the start notice says it runs in the background, what happens if it cannot finish, and says the page can be closed ONLY with the always-on driver", () => {
    const notice = jobStartedNotice({ targetVolumeMax: 1500, driver: "cron" });
    expect(notice.title).toBe("بدأ تنفيذ طلبك الكبير");
    expect(notice.body).toContain("حتى ١٥٠٠ سجل");
    expect(notice.body).toContain("تقدر تقفل الصفحة");
    expect(notice.body).toContain("هنبعتلك إيميل أول ما نخلص");
    expect(notice.body).toContain("فهو حجز مؤقت مُحرَّر كاملًا دون خصم");
    // without the driver (the default, and anything that is not «cron») the notice is the honest one
    for (const driver of ["tab", undefined] as const) {
      const honest = jobStartedNotice({ targetVolumeMax: 1500, driver });
      expect(honest.body).not.toContain("يمكنك إغلاق الصفحة");
      expect(honest.body).toContain("أبقِ الصفحة مفتوحة");
      expect(honest.body).toContain("أبقِ الصفحة مفتوحة حتى تكتمل المهمة");
      expect(honest.body).not.toContain("عند عودتك");
      expect(honest.body).toContain("حتى ١٥٠٠ سجل");
      expect(honest.body).not.toContain("سنخبرك عند اكتماله");
      expect(honest.body).toContain("فهو حجز مؤقت مُحرَّر كاملًا دون خصم");
    }
  });

  it("the stall notice says the request stopped and the whole reserve came back with no charge", () => {
    const notice = jobStalledNotice();
    expect(notice.body).toContain("حجز مؤقت مُحرَّر كاملًا دون أي خصم");
    expect(notice.body).toContain("دون أي خصم");
  });

  it("every notice is plain Arabic: no Latin letters, no digits outside Arabic-Indic, no provider, file, link or id", () => {
    for (const notice of [jobStartedNotice({ targetVolumeMax: 321 }), jobStalledNotice()]) {
      for (const text of [notice.title, notice.body]) {
        expect(text).not.toMatch(/[A-Za-z0-9]|undefined|null|NaN|https?:|\.xlsx|\.csv|\.pdf|endpoint|\$|USD/i);
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      }
      expect(notice.link.startsWith("/dashboard/")).toBe(true);
    }
  });

  it("inserting a notice never throws and reports whether it was saved", async () => {
    const saved: any[] = [];
    const ok = { from: () => ({ insert: async (row: any) => { saved.push(row); return { error: null }; } }) };
    expect(await insertJobNotice(ok, "u1", jobStalledNotice())).toBe(true);
    expect(saved[0]).toMatchObject({ user_id: "u1", read: false, link: "/dashboard/requests" });
    expect(saved[0].id).toMatch(/^notif_\d+_/);
    expect(await insertJobNotice({ from: () => ({ insert: async () => ({ error: { code: "x" } }) }) }, "u1", jobStalledNotice())).toBe(false);
    expect(await insertJobNotice({ from: () => { throw new Error("down"); } }, "u1", jobStalledNotice())).toBe(false);
  });

  it("the start notice is sent on acceptance only when the first chunk started and the job is long; it never fails the acceptance", () => {
    const route = readFileSync("src/app/api/chat/accept-quote/route.ts", "utf8");
    expect(route).toContain("shouldSendStartedNotice({ workerStarted: Boolean(workerDispatch.started), volume, isLongJob: isLongJob(volume), isModelPlanned, driver: driverNow })"); // a model-planned job (a mission or a single stage) also gets the in-site notice while the background driver is live
    const block = route.slice(route.indexOf("A large request is announced in-app"), route.indexOf("return NextResponse.json({\n      success: true,"));
    expect(block).toContain("} catch {");
    expect(block).not.toMatch(/throw|return NextResponse/);
  });
});

/* ---------------------------------------------------------------- the watchdog */

const state = vi.hoisted(() => ({
  stale: [] as any[],
  release: { success: true, released_credits: 207, already_released: false } as any,
  notifications: [] as any[],
  emails: [] as Array<{ template: string; to: string; vars: Record<string, string>; key?: string }>,
}));

vi.mock("../src/lib/server/cronAuth", () => ({ verifyCronSecret: () => true }));
vi.mock("../src/lib/supabase/ledger", async (original) => ({ ...(await original<any>()), getBalance: vi.fn(async () => 5123) }));
vi.mock("../src/lib/server/sendPlatformEmail", async (original) => ({
  ...(await original<any>()),
  getRecipient: vi.fn(async () => ({ email: "u1@example.com", name: "سلمى" })),
  sendPlatformEmail: vi.fn(async (template: string, to: string, vars: Record<string, string>, key?: string) => { state.emails.push({ template, to, vars, key }); return { ok: true }; }),
}));
vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async () => ({ data: state.release, error: null })),
    auth: { admin: {} },
    storage: { from: () => ({ list: async () => ({ data: [] }), remove: async () => ({}) }) },
    from: (table: string) => {
      const api: any = {
        select: () => api, eq: () => api, in: () => api, or: () => api, not: () => api, lte: () => api, limit: () => api,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: async (row: any) => { if (table === "notifications") state.notifications.push(row); return { error: null }; },
        delete: () => api, update: () => api,
        then: (resolve: any) => resolve({ data: table === "jobs" ? state.stale : [], error: null }),
      };
      return api;
    },
  })),
}));

function watchdogRequest() {
  const { NextRequest } = require("next/server");
  return new NextRequest("http://localhost/api/cron/watchdog", { headers: { authorization: "Bearer x" } });
}

describe("the watchdog tells the customer about a stalled job it released", () => {
  beforeEach(() => {
    state.stale = [{ id: "job_stalled_1", user_id: "u1", status: "running", step: 3 }];
    state.release = { success: true, released_credits: 207, already_released: false };
    state.notifications = [];
    state.emails = [];
  });

  it("in-app and by e-mail (the refund e-mail with the points returned), once", async () => {
    const { GET } = await import("../src/app/api/cron/watchdog/route");
    const res = await GET(watchdogRequest());
    expect(res.status).toBe(200);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({ user_id: "u1", title: "توقف طلبك: حجز مؤقت مُحرَّر", link: "/dashboard/requests" });
    expect(state.emails).toHaveLength(1);
    expect(state.emails[0]).toMatchObject({ template: "refund", to: "u1@example.com", key: "stalled-refund:job_stalled_1" });
    expect(state.emails[0].vars).toMatchObject({ Name: "سلمى", Points: "٢٠٧", Balance: "٥١٢٣" });
    expect(Object.values(state.emails[0].vars).join(" ")).not.toMatch(/job_|endpoint|https?:/i);
  });

  it("nothing is sent for a job that was already released, or when no points came back", async () => {
    const { GET } = await import("../src/app/api/cron/watchdog/route");
    state.release = { success: true, released_credits: 207, already_released: true };
    await GET(watchdogRequest());
    expect(state.notifications).toHaveLength(0);
    expect(state.emails).toHaveLength(0);
    state.release = { success: true, released_credits: 0, already_released: false };
    await GET(watchdogRequest());
    expect(state.notifications).toHaveLength(1); // the customer is still told the request stopped
    expect(state.emails).toHaveLength(0); // but no refund e-mail for zero points
  });
});
