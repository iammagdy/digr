import { describe, expect, it, vi } from "vitest";
import { estimateMission, estimateSlug, estimateSummaryAr, parseEstimateText } from "../src/lib/missionEstimate";
import { computePublicCalculatorQuote } from "../src/lib/calculatorPricing";
import { DECISION_MAKER_UNIT_PRICES_POINTS } from "../src/functions/shared/decisionMakerPricing";
import { createRateLimiter, clientKey } from "../src/lib/server/publicRateLimit";

const TODAY = new Date(Date.UTC(2026, 9, 20));

describe("the public estimate uses the quote writer's pricing", () => {
  it("a comments estimate takes its unit price from the shared pricing function and reserves with the 15% buffer", () => {
    const r = estimateMission({ kind: "comments", platform: "youtube", volume: 100 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const shared = computePublicCalculatorQuote(r.slug, 100, 100);
    expect(r.unitPricePoints).toBe(shared.unitPricePoints);
    expect(r.expectedPoints).toBe(Math.ceil(100 * shared.unitPricePoints));
    expect(r.reservePoints).toBe(Math.ceil(100 * shared.unitPricePoints * 1.15));
    expect(r.reservePoints).toBeGreaterThanOrEqual(r.expectedPoints);
    expect(r.expectedEgp).toBeCloseTo(r.expectedPoints * 0.1, 2);
  });

  it("a request bigger than one job's limit says so, with the jobs needed (30,000 comments: one job holds 13,913 at the default limit of 4,400 points)", () => {
    const r = estimateMission({ kind: "comments", platform: "youtube", volume: 30000 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.fitsInOneJob).toBe(false);
    expect(r.maxVolumeInOneJob).toBe(13913);
    expect(r.jobsNeeded).toBe(3);
    expect(r.maxVolumeInOneJob * r.unitPricePoints * 1.15).toBeLessThanOrEqual(r.jobCapPoints + r.unitPricePoints);
    expect(r.notesAr.join(" ")).toContain("طلبات منفصلة");
  });

  it("5,000 comments fit one job whole (reserve 1,582 points)", () => {
    const r = estimateMission({ kind: "comments", platform: "youtube", volume: 5000 });
    expect(r.status === "ok" && r.fitsInOneJob && r.jobsNeeded === 1 && r.reservePoints === 1582).toBe(true);
  });

  it("a small request fits in one job", () => {
    const r = estimateMission({ kind: "comments", platform: "youtube", volume: 10 });
    expect(r.status === "ok" && r.fitsInOneJob && r.jobsNeeded === 1).toBe(true);
  });

  it("a budget in points sets the volume the reserve can hold, never above the budget", () => {
    const r = estimateMission({ kind: "comments", platform: "youtube", budgetPoints: 300 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.reservePoints).toBeLessThanOrEqual(300);
    expect(r.volume).toBeGreaterThan(0);
  });

  it("an open-ended request needs a cap and shows no price", () => {
    const r = estimateMission({ kind: "comments", platform: "youtube", openEnded: true });
    expect(r.status).toBe("needs_cap");
    expect(estimateMission({ kind: "comments", platform: "youtube" }).status).toBe("needs_cap");
  });

  it("social data without a platform asks for the platform", () => {
    expect(estimateMission({ kind: "comments", volume: 10 }).status).toBe("needs_platform");
  });

  it("a platform without that data type is unsupported, in Arabic", () => {
    const r = estimateMission({ kind: "videos", platform: "x", volume: 10 });
    expect(r.status).toBe("unsupported");
    expect(r.notesAr.join(" ")).not.toMatch(/undefined|null|NaN/);
  });

  it("decision makers are priced per person plus the contact fields asked for", () => {
    const both = estimateMission({ kind: "people", volume: 10 });
    const mailOnly = estimateMission({ kind: "people", volume: 10, contactFields: ["work_email"] });
    expect(both.status === "ok" && mailOnly.status === "ok").toBe(true);
    if (both.status !== "ok" || mailOnly.status !== "ok") return;
    expect(both.unitPricePoints).toBe(DECISION_MAKER_UNIT_PRICES_POINTS.basePerson + DECISION_MAKER_UNIT_PRICES_POINTS.workEmail + DECISION_MAKER_UNIT_PRICES_POINTS.phone);
    expect(mailOnly.unitPricePoints).toBe(DECISION_MAKER_UNIT_PRICES_POINTS.basePerson + DECISION_MAKER_UNIT_PRICES_POINTS.workEmail);
    expect(both.expectedPoints).toBeGreaterThan(mailOnly.expectedPoints);
  });

  it("the summary is approximate, in Arabic digits, with no dollars", () => {
    const r = estimateMission({ kind: "comments", platform: "youtube", volume: 100 });
    if (r.status !== "ok") throw new Error("expected ok");
    const text = estimateSummaryAr(r);
    expect(text).toMatch(/حوالي/);
    expect(text).toMatch(/ج\.م/);
    expect(text).not.toMatch(/[0-9$]|USD|undefined|NaN/);
  });

  it("slugs: Facebook videos are its posts; unknown pairs have none", () => {
    expect(estimateSlug("videos", "facebook")).toBe(estimateSlug("posts", "facebook"));
    expect(estimateSlug("comments", null)).toBeNull();
  });
});

describe("the free-text box reads a request by code only", () => {
  it("M3: 37,500 posts and replies on X reads the volume and the platform", () => {
    const p = parseEstimateText("عايز ٣٧٥٠٠ بوست وردود على إكس عن ماتش مصر والمغرب", TODAY);
    expect(p.input).toMatchObject({ platform: "x", volume: 37500 });
    expect(p.understoodAr).toMatch(/^فهمت أنك تريد/);
    const r = estimateMission(p.input!);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.fitsInOneJob).toBe(false);
      expect(r.jobsNeeded).toBeGreaterThan(1);
    }
  });

  it("M1: top videos of channels with all comments is open-ended and needs a cap", () => {
    const p = parseEstimateText("عايز أجيب أكتر ١٠ فيديوهات مشاهدة من ٥ قنوات أخبار على يوتيوب مع كل التعليقات ورابط الفيديو", TODAY);
    expect(p.input).toMatchObject({ kind: "comments", platform: "youtube", openEnded: true });
    expect(estimateMission(p.input!).status).toBe("needs_cap");
  });

  it("a stated budget in points becomes a volume", () => {
    const p = parseEstimateText("عايز تعليقات يوتيوب بميزانية ٤٠٠ نقطة", TODAY);
    expect(p.input?.budgetPoints).toBe(400);
    expect(estimateMission(p.input!).status).toBe("ok");
  });

  it("a company request with a count is priced", () => {
    const p = parseEstimateText("عايز ٥٠ شركة مقاولات في مصر", TODAY);
    expect(p.input).toMatchObject({ kind: "companies", volume: 50 });
    expect(estimateMission(p.input!).status).toBe("ok");
  });

  it("decision makers: only e-mails when phones are not asked for", () => {
    const p = parseEstimateText("عايز ٢٠ مدير في شركات مقاولات مع الإيميلات", TODAY);
    if (p.input?.kind === "people") expect(p.input.contactFields).toEqual(["work_email"]);
  });

  it("empty or unclear text gives a plain Arabic hint, never a price", () => {
    expect(parseEstimateText("", TODAY).input).toBeNull();
    const unclear = parseEstimateText("مرحبا", TODAY);
    expect(unclear.input).toBeNull();
    expect(unclear.missingAr.join(" ")).not.toMatch(/undefined|null|NaN/);
  });

  it("never calls a model (the module imports none)", async () => {
    const source = (await import("node:fs")).readFileSync("src/lib/missionEstimate.ts", "utf8");
    expect(source).not.toMatch(/llm|openai|anthropic|executeTurn|fetch\(/i);
  });
});

describe("the public rate limiter", () => {
  it("allows up to the limit per window, then refuses with a retry time, then allows again", () => {
    let t = 1_000_000;
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3, now: () => t });
    expect([1, 2, 3].map(() => limiter.check("a").allowed)).toEqual([true, true, true]);
    const refused = limiter.check("a");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.check("b").allowed).toBe(true);
    t += 61_000;
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("keeps a bounded number of keys", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 3 });
    for (const k of ["a", "b", "c", "d"]) limiter.check(k);
    expect(limiter.check("a").allowed).toBe(true); // "a" was dropped, so it starts fresh
  });

  it("reads the visitor from x-forwarded-for, first hop", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" });
    expect(clientKey(headers)).toBe("1.2.3.4");
    expect(clientKey(new Headers())).toBe("unknown");
  });
});

import { PUBLIC_LIMITS_PER_MINUTE } from "../src/lib/server/publicRateLimit";

describe("the public endpoints", () => {
  it("the estimate endpoint refuses past the limit with 429 and an Arabic message", async () => {
    vi.resetModules();
    const { POST } = await import("../src/app/api/calculator/estimate/route");
    const make = () => new Request("http://x/api/calculator/estimate", { method: "POST", headers: { "x-forwarded-for": "9.9.9.9", "content-type": "application/json" }, body: JSON.stringify({ kind: "comments", platform: "youtube", volume: 10 }) }) as any;
    let last: Response | null = null;
    for (let i = 0; i < PUBLIC_LIMITS_PER_MINUTE.estimate + 1; i++) last = await POST(make());
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();
    expect((await last!.json()).error).toMatch(/انتظر/);
  });

  it("answers a structured request and a text request with computed numbers", async () => {
    vi.resetModules();
    const { POST } = await import("../src/app/api/calculator/estimate/route");
    const call = async (body: unknown) => POST(new Request("http://x", { method: "POST", headers: { "x-forwarded-for": "8.8.8.8" }, body: JSON.stringify(body) }) as any).then((r) => r.json());
    const a = await call({ kind: "comments", platform: "youtube", volume: 100 });
    expect(a.result.status).toBe("ok");
    expect(a.summaryAr).toMatch(/حوالي/);
    const b = await call({ text: "عايز ٢٠٠ تعليق من يوتيوب" });
    expect(b.result?.status).toBe("ok");
    expect((await call({})).success).toBe(false);
  });
});
