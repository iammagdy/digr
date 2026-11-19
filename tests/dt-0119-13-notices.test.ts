import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildMissionNotice, noticeTitleAr, type MissionNoticeKind } from "../src/lib/agentMission/notices";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { sendMissionNotice } from "../src/lib/server/missionNotify";
import { renderEmailTemplate } from "../supabase/functions/send-email/templates";
import { renderCustomerMessageHtml } from "../src/lib/customerMessage";
import { INTERNAL_FAILURE_AR } from "../agent/src/runMission";
import { createMemoryDb } from "./helpers/memoryDb";

/**
 * DT-20261119-13 (D-0133, D-0134, D-0140 + C1–C7):
 * Verifies mission result e-mails, in-site notices, preheader anti-bleed padding,
 * card partial end line, multi-stage entity nouns, and shortfall wording.
 */

function assertNoticeInvariants(n: ReturnType<typeof buildMissionNotice>) {
  const e = n.email!;
  expect(e).not.toBeNull();
  expect([...e.subject].length, `subject too long: «${e.subject}»`).toBeLessThanOrEqual(45);
  expect([...e.preheader].length, `preheader too long: «${e.preheader}»`).toBeLessThanOrEqual(60);
  expect(e.preheader).not.toBe(e.subject);
  expect(e.preheader).not.toBe(e.heading);
  expect(e.subject).not.toBe(e.heading);
  const all = [n.title, n.body, e.subject, e.preheader, e.heading, e.lead, e.detail1, e.detail2];
  for (const s of all.filter(Boolean)) {
    expect(checkCustomerText(s, { maxChars: 600 }).issues, s).toEqual([]);
    expect(s, s).not.toMatch(/[0-9A-Za-z]/);
    expect(s, s).not.toContain("خلل من جانبنا");
    expect(s, s).not.toContain("عناصر");
  }
}

describe("DT-20261119-13 E1–E9 (as corrected by C1–C7)", () => {
  it("E1 (C1 real plan shape: 3 shipping companies + email/phone contacts) -> uses contacts noun (never «مدير» and never «عناصر»)", () => {
    const title = noticeTitleAr({
      plan: {
        stages: [
          { key: "companies", deliver: true, title_ar: "شركات شحن في مصر", parent_key: null, expected_rows: 3 },
          { key: "contacts", deliver: true, title_ar: "بيانات تواصل الشركات", parent_key: "companies", expected_rows: 5 },
        ],
      },
      requestText: "٣ شركات شحن في مصر بالإيميل والتليفون",
    });
    const n = buildMissionNotice("partial", {
      delivered: 6,
      planned: 8,
      chargedPoints: 346,
      releasedPoints: 114,
      reservedPoints: 460,
      hasJob: true,
      shortfallClauseAr: "لأن بعض الشركات لم نجد لها بيانات تواصل منشورة",
      stages: [
        { titleAr: "شركات شحن في مصر", delivered: 3, planned: 3, parentKey: null, isCompanies: true } as any,
        { titleAr: "بيانات تواصل الشركات", delivered: 3, planned: 5, parentKey: "companies", isContacts: true },
      ],
    }, title);

    assertNoticeInvariants(n);
    const all = [n.title, n.body, n.email!.subject, n.email!.preheader, n.email!.heading, n.email!.lead, n.email!.detail1].join(" | ");
    expect(all).not.toMatch(/مدير|مدراء|عناصر|اكتملت|حجز مؤقت مُحرَّر/);
    expect(n.email!.preheader).not.toMatch(/خُصم|نقطة/);
    expect(n.email!.lead).toContain("جهات تواصل");
    expect(n.email!.heading).toContain("تسليم جزئي");
    expect(n.email!.detail1).toBe("خُصم ٣٤٦ نقطة مقابل ما سُلّم فقط، وعاد ١١٤ نقطة لرصيدك.");
  });

  it("E2 (failed-ours, zero delivered): no «عايز» without plan, no «خلل من جانبنا», money said ONCE in DetailOne (C2, C4, C5, C6)", () => {
    const title = noticeTitleAr({ plan: null, requestText: "عايز شركتين تسويق في القاهرة ومدير كل شركة" });
    expect(title).toBe("مهمتك");
    const n = buildMissionNotice("failed", {
      delivered: 0, planned: 4, chargedPoints: 0, releasedPoints: 200, reservedPoints: 200, hasJob: true, cause: "internal",
    }, title);
    assertNoticeInvariants(n);
    expect(n.email!.subject).toContain("تعذّر استكمال الطلب");
    expect(n.email!.subject).not.toMatch(/عايز|لم يُخصم/);
    expect(n.email!.preheader).toMatch(/لم يُخصم شيء/);
    expect(n.email!.preheader).not.toMatch(/[٠-٩]/);
    expect(n.email!.lead).not.toMatch(/أعدنا كامل الحجز|حجز|نقطة|خلل من جانبنا/);
    expect(n.email!.detail1).toBe("لم يُخصم شيء، وعاد الحجز المؤقت (٢٠٠ نقطة) كاملًا لرصيدك.");
  });

  it("E3 (partial 100 companies + 83/100 managers, D-0140 scale): drops «كاملة», subject <= 45, uses «مديرًا / مدير» (C1, C5, C7)", () => {
    const n = buildMissionNotice("partial", {
      delivered: 183, planned: 200, chargedPoints: 9200, releasedPoints: 1300, reservedPoints: 10500, hasJob: true,
      shortfallClauseAr: "لأن بعض الشركات لم نجد لها مديرًا مطابقًا في المصادر",
      stages: [
        { titleAr: "شركات مقاولات في الرياض", delivered: 100, planned: 100, parentKey: null },
        { titleAr: "مدير كل شركة", delivered: 83, planned: 100, parentKey: "companies", isPeople: true },
      ],
    }, "١٠٠ شركة مقاولات في الرياض");
    assertNoticeInvariants(n);
    expect(n.email!.lead).not.toContain("كاملة");
    expect(n.email!.lead).toContain("تم تسليم ١٠٠ شركة و٨٣ مديرًا من أصل ١٠٠ مدير");
    expect(n.email!.detail1).toBe("خُصم ٩٬٢٠٠ نقطة مقابل ما سُلّم فقط، وعاد ١٬٣٠٠ نقطة لرصيدك.");
  });

  it("E4 (completed 50 companies × 2 managers): subject <= 45 («— النتائج جاهزة»), preheader has no money", () => {
    const n = buildMissionNotice("completed", {
      delivered: 150, planned: 150, chargedPoints: 7500, releasedPoints: 0, reservedPoints: 7500, hasJob: true,
      stages: [
        { titleAr: "شركات استيراد في دبي", delivered: 50, planned: 50, parentKey: null },
        { titleAr: "مدير كل شركة", delivered: 100, planned: 100, parentKey: "companies", isPeople: true },
      ],
    }, "٥٠ شركة استيراد وتصدير في دبي");
    assertNoticeInvariants(n);
    expect(n.email!.subject).toMatch(/— النتائج جاهزة$/);
    expect(n.email!.preheader).not.toMatch(/خُصم|نقطة/);
    expect(n.email!.detail1).toBe("خُصم ٧٬٥٠٠ نقطة مقابل ٥٠ شركة و١٠٠ مدير.");
  });

  it("E5 (companies-only partial 180 of 200) & E6 (300 tweets completed counter-case)", () => {
    const e5 = buildMissionNotice("partial", {
      delivered: 180, planned: 200, chargedPoints: 3600, releasedPoints: 400, reservedPoints: 4000, noun: "شركة", hasJob: true,
    }, "٢٠٠ شركة برمجيات وتطبيقات في مصر");
    assertNoticeInvariants(e5);
    expect(e5.email!.lead).toContain("١٨٠ من ٢٠٠ شركة");

    const e6 = buildMissionNotice("completed", {
      delivered: 300, planned: 300, chargedPoints: 600, releasedPoints: 0, reservedPoints: 600, noun: "تغريدة", hasJob: true,
    }, "تغريدات عن النادي الأهلي");
    assertNoticeInvariants(e6);
    expect(e6.email!.subject).toBe("تغريدات عن النادي الأهلي — النتائج جاهزة");
    expect(e6.email!.preheader).not.toMatch(/خُصم|نقطة/);
    expect(e6.email!.detail1).toBe("خُصم ٦٠٠ نقطة مقابل ٣٠٠ تغريدة.");
  });

  it("E7 (failed-empty), E8 (unserved no-hold), E9 (stopped): distinct preheaders, money ONCE (C2, C4, C5)", () => {
    const e7 = buildMissionNotice("unserved", { delivered: 0, planned: 10, chargedPoints: 0, releasedPoints: 200, reservedPoints: 200, hasJob: true, cause: "empty" }, "شركات تصنيع خلايا شمسية");
    assertNoticeInvariants(e7);
    expect(e7.email!.subject).toMatch(/— لا توجد نتائج مطابقة$/);
    expect(e7.email!.detail1).toBe("لم يُخصم شيء، وعاد الحجز المؤقت (٢٠٠ نقطة) كاملًا لرصيدك.");

    const e8 = buildMissionNotice("unserved", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false }, "بيانات مخالفات مرورية");
    assertNoticeInvariants(e8);
    expect(e8.email!.subject).toMatch(/— خارج مصادرنا حاليًا$/);
    expect(e8.email!.detail1).toBe("لم يُحجز أي رصيد ولم يُخصم شيء.");

    const e9 = buildMissionNotice("failed", { delivered: 0, planned: 20, chargedPoints: 0, releasedPoints: 200, reservedPoints: 200, hasJob: true }, "تقييمات فنادق شرم الشيخ على خرائط جوجل");
    assertNoticeInvariants(e9);
    expect(e9.email!.subject).toMatch(/— توقف قبل الاكتمال$/);
    expect(e9.email!.detail1).toBe("لم يُخصم شيء، وعاد الحجز المؤقت (٢٠٠ نقطة) كاملًا لرصيدك.");
  });
});

describe("DT-20261119-13 Scale (50/100/200 companies × 1–2 managers, ± contacts) & Counter-cases", () => {
  it.each([
    { companies: 50, per: 1, contacts: false },
    { companies: 50, per: 2, contacts: true },
    { companies: 100, per: 1, contacts: true },
    { companies: 100, per: 2, contacts: false },
    { companies: 200, per: 1, contacts: false },
    { companies: 200, per: 2, contacts: true },
  ])("scale $companies × $per (contacts=$contacts) passes length + C1–C7 invariants across completed/partial/failed", ({ companies, per, contacts }) => {
    const childPlanned = companies * per;
    const childDelivered = Math.max(1, Math.floor(childPlanned * 0.8));
    const title = `${companies} شركة برمجيات وتطبيقات في القاهرة والإسكندرية`;
    for (const kind of ["completed", "partial", "failed"] as MissionNoticeKind[]) {
      const stages = [
        { titleAr: "شركات برمجيات في القاهرة", delivered: kind === "failed" ? 0 : companies, planned: companies, parentKey: null },
        ...(contacts
          ? [{ titleAr: "بيانات تواصل الشركات", delivered: kind === "completed" ? childPlanned : childDelivered, planned: childPlanned, parentKey: "companies", isContacts: true }]
          : [{ titleAr: "مدير كل شركة", delivered: kind === "completed" ? childPlanned : childDelivered, planned: childPlanned, parentKey: "companies", isPeople: true }]),
      ];
      const n = buildMissionNotice(kind, {
        delivered: kind === "failed" ? 0 : companies + (kind === "completed" ? childPlanned : childDelivered),
        planned: companies + childPlanned,
        chargedPoints: kind === "failed" ? 0 : 1200,
        releasedPoints: kind === "partial" ? 300 : kind === "failed" ? 1500 : 0,
        reservedPoints: 1500,
        hasJob: true,
        ...(kind === "failed" ? { cause: "internal" as const } : {}),
        stages,
      }, title);
      assertNoticeInvariants(n);
      if (contacts && kind !== "failed") {
        expect(n.email!.lead).not.toMatch(/مدير/);
      }
    }
  });

  it("C3: notice code never computes releasedPoints when omitted (falls back to «وعاد باقي الحجز المؤقت لرصيدك»)", () => {
    const n = buildMissionNotice("partial", {
      delivered: 10, planned: 20, chargedPoints: 500, releasedPoints: 0, reservedPoints: 900, noun: "شركة", hasJob: true,
    }, "٢٠ شركة شحن");
    assertNoticeInvariants(n);
    expect(n.email!.detail1).toBe("خُصم ٥٠٠ نقطة مقابل ما سُلّم فقط، وعاد باقي الحجز المؤقت لرصيدك.");
    expect(n.email!.detail1).not.toContain("٤٠٠");
  });

  it("sendMissionNotice uses clean plan title when plan exists and «مهمتك» when no plan exists (no «عايز»)", async () => {
    const db = createMemoryDb();
    db.seed("missions", [
      { id: "msn_noplan", user_id: "u1", request_text: "عايز 10 شركات تسويق في الجيزة", plan: null },
    ]);
    db.seed("messages", [{ id: "m1", user_id: "u1", role: "assistant", conversation_id: "c1", plan: { agentMissionId: "msn_noplan" }, created_at: "2026-11-19T10:00:00Z" }]);
    const notices: any[] = [];
    const client: any = {
      from: (t: string) => (t === "notifications" ? { insert: async (r: any) => { notices.push(r); return { error: null }; } } : db.from(t)),
    };
    await sendMissionNotice(client, { userId: "u1", missionId: "msn_noplan", jobId: null, kind: "failed", facts: { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false, cause: "internal" } });
    expect(notices[0].title).not.toMatch(/عايز|خلل من جانبنا/);
    expect(notices[0].body).not.toMatch(/عايز|خلل من جانبنا/);
  });

  it("PRELUDE_PAD >= 100 invisible chars in templates.ts and customerMessage.ts; card partial endLine never says «اكتملت»", () => {
    const { html } = renderEmailTemplate("job-update", {
      Name: "سارة", Subject: "عنوان", Preheader: "ملخص", Heading: "رأس", Lead: "بداية", DetailOne: "تفصيل", DetailTwo: "", ButtonLabel: "افتح", JobURL: "https://diger.tech",
    });
    const pad = /<div style="display:none[^>]*>ملخص([^<]*)<\/div>/.exec(html)?.[1] ?? "";
    expect(pad.length).toBeGreaterThanOrEqual(400);

    const msgHtml = renderCustomerMessageHtml({ subject: "عنوان", heading: "رأس", body: "نص طويل للرسالة" });
    const msgPad = /<div style="display:none[^>]*>[^<]*?((?:&#8199;|&#65279;|&#847;)+)<\/div>/.exec(msgHtml)?.[1] ?? "";
    expect(msgPad.length).toBeGreaterThanOrEqual(400);

    const view = customerMissionView({
      mission: {
        id: "msn_part_card", status: "completed", question_ar: null,
        plan_public: { summary_ar: "س", stages: [{ key: "companies", title_ar: "الشركات", expected_rows: 10, deliver: true, columns: [] }], price: { reserve_points: 100 } },
        reserved_points: 100, unit_price_points: 10, delivered_units: 4, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-19T10:00:00Z",
      },
      events: [],
    });
    expect(view.phase).toBe("partial");
    expect(view.endLineAr ?? "").not.toContain("اكتملت");
    expect(INTERNAL_FAILURE_AR).not.toContain("خلل من جانبنا");
    expect(readFileSync("supabase/functions/send-email/templates.ts", "utf8")).toContain("repeat(");
  });
});
