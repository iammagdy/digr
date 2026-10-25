import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";

const state = vi.hoisted(() => ({
  user: null as any,
  job: null as any,
  calls: [] as string[],
  uploads: [] as string[],
}));

function chain(result: () => any) {
  const c: any = {
    select: () => c, eq: () => c, not: () => c, order: () => c, limit: () => c,
    single: async () => result(),
    maybeSingle: async () => result(),
    then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
  };
  return c;
}

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    rpc: async (name: string) => { state.calls.push(`rpc:${name}`); return { data: null, error: null }; },
    from: (table: string) => {
      state.calls.push(`from:${table}`);
      if (table === "jobs") return chain(() => ({ data: state.job, error: state.job ? null : new Error("nf") }));
      return chain(() => ({ data: [], error: null }));
    },
    storage: {
      from: () => ({
        download: async () => ({ data: null, error: new Error("nf") }),
        upload: async (path: string) => { state.uploads.push(path); return { error: null }; },
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x" }, error: null }),
      }),
    },
  })),
}));

import { GET as download } from "../src/app/api/jobs/[id]/download/route";
import { deliveredNothing, onRequestFormats, producedFormats } from "../src/lib/producedFormats";
import { buildDeterministicPlanFromIntent } from "../src/functions/shared/chatHandler";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { extractRequestIntent } from "../src/lib/requestIntent";
import { planScopeRows, roleTitleDisplayAr } from "../src/lib/quoteScopeGaps";
import { CEILING_MESSAGE_AR } from "../src/lib/server/providerLimits";
import { DEFAULT_Q, SHEETS, STATEMENTS } from "../src/components/landing/data";
import { FAQS } from "../src/components/landing/landingFaq";

describe("a failed request that delivered nothing offers no download", () => {
  it("producedFormats does not fall back to Excel when nothing was delivered; the default is unchanged otherwise", () => {
    expect(producedFormats(null, { nothingDelivered: true })).toEqual([]);
    expect(producedFormats({ xlsx: "x", pdf: null, csv: null }, { nothingDelivered: true })).toEqual([]);
    expect(onRequestFormats(null, { nothingDelivered: true })).toEqual([]);
    expect(producedFormats(null)).toEqual(["xlsx"]);
    expect(producedFormats({ xlsx: null, pdf: null, csv: null })).toEqual(["xlsx"]);
  });

  it("deliveredNothing is true only for a failed, cancelled or refused request with no delivered record", () => {
    expect(deliveredNothing({ status: "failed", delivered: 0 })).toBe(true);
    expect(deliveredNothing({ status: "failed", delivered: null })).toBe(true);
    expect(deliveredNothing({ status: "cancelled", delivered: 0 })).toBe(true);
    expect(deliveredNothing({ status: "failed", delivered: 3 })).toBe(false);
    expect(deliveredNothing({ status: "done", delivered: 0 })).toBe(false);
    expect(deliveredNothing({ status: "completed", delivered: 5 })).toBe(false);
    expect(deliveredNothing(null)).toBe(false);
  });

  describe("the download route", () => {
    const req = new NextRequest("http://localhost/api/jobs/job_x/download?format=xlsx");
    const params = { params: Promise.resolve({ id: "job_x" }) };
    beforeEach(() => {
      state.user = { id: "owner-1", app_metadata: {} };
      state.calls = [];
      state.uploads = [];
    });
    afterEach(() => vi.restoreAllMocks());

    it("refuses a failed job with no delivered record in one Arabic sentence: no file, no ledger or provider call", async () => {
      state.job = { id: "job_x", user_id: "owner-1", status: "failed", delivered_units: 0, target_volume_max: 2, params: {}, endpoint_id: "icypeas.companies.search" };
      const res = await download(req, params);
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.success).toBe(false);
      expect(body.error).toBe("لا يوجد ملف لتحميله لأن هذا الطلب لم يُسلّم أي سجل، ولم يُخصم منك أي رصيد.");
      expect(body.error).not.toMatch(/[A-Za-z]/);
      expect(state.uploads).toHaveLength(0);
      expect(state.calls.filter((c) => c.startsWith("rpc:") || c.includes("credit_ledger") || c.includes("provider_costs"))).toEqual([]);
      expect(state.calls).toEqual(["from:jobs"]);
    });

    it("another customer's failed job is still a 403, not a hint about its state", async () => {
      state.job = { id: "job_x", user_id: "someone-else", status: "failed", delivered_units: 0 };
      const res = await download(req, params);
      expect(res.status).toBe(403);
    });
  });

  it("the results panel hides its downloads and the report tab for such a request", () => {
    const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
    expect(canvas).toContain('const nothingDelivered = jobStatus === "failed"');
    expect(canvas).toContain("(nothingDelivered ? [] : [");
    expect(canvas).toContain('!nothingDelivered && producedFormats(fileIds).includes("pdf")');
  });
});

describe("the decision-makers card", () => {
  const caps = APPROVED_CAPABILITY_CATALOG as any[];
  const PEOPLE = "٣ مديرين في شركات الطاقة في السعودية مع إيميلاتهم وأرقامهم";
  const brief = { platforms: [], topics: [], formats: [] } as any;

  it("the plan summary names the sector from the request, in Arabic, and the country", () => {
    const plan = buildDeterministicPlanFromIntent(extractRequestIntent(PEOPLE), PEOPLE, brief, caps);
    expect(plan?.summaryAr).toBe("بحث ٣ من صناع القرار والمهنيين في قطاع الطاقة في المملكة العربية السعودية");
    expect(plan?.summaryAr).not.toMatch(/[A-Za-z]/);
  });

  it("without a recognised sector the summary is unchanged", () => {
    const text = "٣ مديرين في السعودية";
    const plan = buildDeterministicPlanFromIntent(extractRequestIntent(text), text, brief, caps);
    if (plan) expect(plan.summaryAr).not.toContain("في قطاع");
  });

  it("the role chip shows an Arabic title; the stored provider value is untouched", () => {
    expect(roleTitleDisplayAr("Director")).toBe("مدير");
    expect(roleTitleDisplayAr("CEO")).toBe("الرئيس التنفيذي");
    expect(roleTitleDisplayAr("Founder")).toBe("مؤسس");
    expect(roleTitleDisplayAr("Head of Something")).toBe("Head of Something");
    const items = [{ capabilitySlug: "professional-people-search", endpointId: "treg.people.search", params: { title: "Director", country: "SA", keywords: ["energy"], limit: 3 }, targetVolumeMax: 3 }];
    const chips = planScopeRows(items as any);
    const roleChip = chips.find((chip) => chip.label === "نوع البحث:");
    expect(roleChip?.value).toBe("مدير");
    expect(items[0].params.title).toBe("Director");
  });
});

describe("customer-visible wording", () => {
  it("the daily-limit and ceiling messages name no provider and keep the refund sentence", () => {
    const route = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(route).not.toContain("تم تجاوز الحد اليومي لاستهلاك مزود البيانات");
    expect(route).toContain("تم الوصول إلى حد المعالجة اليومي؛ حاول مرة أخرى لاحقاً. حُرّر الحجز المؤقت كاملًا ولم يُخصم أي رصيد.");
    for (const message of Object.values(CEILING_MESSAGE_AR)) {
      expect(message).not.toMatch(/مزود|المزود|provider/i);
      expect(message).toContain("حُرّر الحجز المؤقت كاملًا ولم يُخصم أي رصيد");
    }
  });

  it("/services and the landing copy no longer say «الخادم»", () => {
    for (const file of ["src/app/services/page.tsx", "src/components/landing/data.ts", "src/components/landing/Sections.tsx"]) {
      expect(readFileSync(file, "utf8"), file).not.toContain("الخادم");
    }
  });

  it("the landing page carries no Latin handle, no format label and no JSON in its text", () => {
    const visible = [DEFAULT_Q, ...STATEMENTS.flatMap((s) => [s.big, s.small]), ...SHEETS.flatMap((s) => [s.name, s.desc]), ...FAQS.flat()];
    for (const text of visible) {
      expect(text, text).not.toMatch(/@[A-Za-z]/);
      expect(text, text).not.toMatch(/\b(?:PDF|CSV|XLSX|JSON)\b/i);
    }
  });
});
