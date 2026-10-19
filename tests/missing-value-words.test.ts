import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { containsMissingToken, isMissingText, planScopeRows, quoteScopeGaps, stripMissingValueWords } from "../src/lib/quoteScopeGaps";
import { buildAutoPlanProposal } from "../src/functions/shared/chatHandler";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";

const authMockState = vi.hoisted(() => ({ user: null as any, adminClient: null as any }));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: authMockState.user }, error: null })) } })),
  createAdminClient: vi.fn(() => authMockState.adminClient || {}),
}));
vi.mock("../src/lib/server/providerGate", () => ({
  getLiveProviderGateStatusFromSettings: vi.fn(async () => ({ isReady: true, reasonCode: "ready", messageAr: "" })),
}));

const MISSING = ["undefined", "null", "NaN", "nan", "", "   ", "  undefined  "];
const companyItem = (country: string, industry = "Electrical/Electronic Manufacturing") => ({
  capabilitySlug: "icypeas-companies-search",
  params: { country, query: { location: { include: [country] }, industry: { include: [industry] } } },
  targetVolumeMax: 2,
});

describe("a value that was never found is missing, never content", () => {
  it("isMissingText: the words «undefined», «null», «NaN», blank and non-strings are missing; real text is not", () => {
    for (const value of MISSING) expect(isMissingText(value), JSON.stringify(value)).toBe(true);
    expect(isMissingText(undefined)).toBe(true);
    expect(isMissingText(null)).toBe(true);
    expect(isMissingText("مصر")).toBe(false);
    expect(isMissingText("Egypt")).toBe(false);
    expect(isMissingText("Nullarbor Plain")).toBe(false);
  });

  it("containsMissingToken finds the words inside a sentence, and only as whole words", () => {
    expect(containsMissingToken("استخراج بيانات ٢ سجل من شركات الكهرباء في undefined")).toBe(true);
    expect(containsMissingToken("الدولة: null")).toBe(true);
    expect(containsMissingToken("العدد NaN")).toBe(true);
    expect(containsMissingToken("استخراج بيانات ٢ سجل من شركات الكهرباء في مصر")).toBe(false);
    expect(containsMissingToken("Nullarbor and undefinedness are words")).toBe(false);
  });

  it("stripMissingValueWords drops the dangling phrase from a customer sentence", () => {
    expect(stripMissingValueWords("استخراج بيانات ٢ سجل من شركات الكهرباء والطاقة الكهربائية في undefined")).toBe("استخراج بيانات ٢ سجل من شركات الكهرباء والطاقة الكهربائية");
    expect(stripMissingValueWords("الدولة: null والعدد ٢")).toBe("الدولة: والعدد ٢");
    expect(stripMissingValueWords("استخراج بيانات ٢ سجل في مصر")).toBe("استخراج بيانات ٢ سجل في مصر");
  });
});

describe("quoteScopeGaps treats those values as missing", () => {
  for (const missing of MISSING) {
    it(`a company plan whose country is ${JSON.stringify(missing)} has a country gap`, () => {
      expect(quoteScopeGaps([companyItem(missing)])).toContain("country");
    });
  }

  it("a company plan whose activity is «undefined» has an industry gap", () => {
    expect(quoteScopeGaps([companyItem("Egypt", "undefined")])).toContain("industry");
  });

  it("a people plan whose country is «undefined» has a country gap", () => {
    const people = [{ capabilitySlug: "professional-people-search", params: { country: "undefined", title: "Director", keywords: ["energy"], limit: 3 }, targetVolumeMax: 3 }];
    expect(quoteScopeGaps(people)).toContain("country");
  });

  it("a param holding the word «undefined» is a placeholder gap", () => {
    expect(quoteScopeGaps([companyItem("undefined")])).toContain("placeholder");
  });

  it("a complete plan has no gap", () => {
    expect(quoteScopeGaps([companyItem("Egypt")])).toEqual([]);
  });

  it("the plan card never prints the words: a missing country chip asks for the value", () => {
    const chips = planScopeRows([companyItem("undefined")] as any);
    for (const chip of chips) {
      expect(`${chip.label} ${chip.value}`).not.toMatch(/undefined|null|NaN/);
    }
    expect(chips.find((chip) => chip.label.includes("الدولة"))?.value).toContain("يلزم تحديد");
  });
});

describe("the scope text is built without the words", () => {
  it("a company plan from a request with no country has no «في undefined» in its summary", () => {
    const plan = buildAutoPlanProposal(
      { platforms: ["companies"], topics: ["كهرباء"], targetVolume: 2, formats: [] } as any,
      APPROVED_CAPABILITY_CATALOG as any[],
      "عايز شركتين كهرباء",
    );
    expect(plan.summaryAr).not.toMatch(/undefined|null|NaN/);
    expect(plan.summaryAr).toContain("استخراج بيانات");
  });
});

describe("a plan with a missing value is never priced", () => {
  it("createAndSaveManagedQuote with enforceScope rejects a company plan whose country is «undefined», before any database call", async () => {
    const { createAndSaveManagedQuote } = await import("../src/functions/shared/planManager");
    const mockDb: any = { from: vi.fn() };
    await expect(
      createAndSaveManagedQuote(mockDb, {
        conversationId: "conv-undefined",
        userId: "user-1",
        plan: { summaryAr: "استخراج بيانات ٢ سجل من شركات الكهرباء والطاقة الكهربائية في مصر", items: [companyItem("undefined")] } as any,
        userBalance: 500,
        capabilities: [],
        enforceScope: true,
      }),
    ).rejects.toThrow("الخطة غير مكتملة");
    expect(mockDb.from).not.toHaveBeenCalled();
  });

  it("createAndSaveManagedQuote with enforceScope rejects a plan whose summary carries «undefined»", async () => {
    const { createAndSaveManagedQuote } = await import("../src/functions/shared/planManager");
    const mockDb: any = { from: vi.fn() };
    await expect(
      createAndSaveManagedQuote(mockDb, {
        conversationId: "conv-undefined-summary",
        userId: "user-1",
        plan: { summaryAr: "استخراج بيانات ٢ سجل من شركات الكهرباء والطاقة الكهربائية في undefined", items: [companyItem("Egypt")] } as any,
        userBalance: 500,
        capabilities: [],
        enforceScope: true,
      }),
    ).rejects.toThrow("الخطة غير مكتملة");
    expect(mockDb.from).not.toHaveBeenCalled();
  });

  describe("accept-quote", () => {
    let rpcCalls: Array<{ name: string; params: any }>;
    beforeEach(() => {
      rpcCalls = [];
      authMockState.user = { id: "user-verified-1", email: "v@example.com", email_confirmed_at: "2026-10-12T00:00:00Z", user_metadata: { email_verified: true } };
      const items = [companyItem("undefined")];
      authMockState.adminClient = {
        from: vi.fn((table: string) => {
          if (table === "plans_quotes") {
            return { select: vi.fn(() => ({ eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: { id: "quote-undefined", items }, error: null })),
              single: vi.fn(async () => ({ data: { id: "quote-undefined", items, quote_hash: "h" }, error: null })),
            })) })) };
          }
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) })) })) };
        }),
        rpc: vi.fn(async (name: string, params: any) => { rpcCalls.push({ name, params }); return { data: { success: true }, error: null }; }),
      };
    });

    it("a company quote whose country is «undefined» is a 409 with zero reserve calls", async () => {
      const { POST } = await import("../src/app/api/chat/accept-quote/route");
      const res = await POST(new NextRequest("http://localhost:3000/api/chat/accept-quote", { method: "POST", body: JSON.stringify({ quoteId: "quote-undefined", explicitApproval: true }) }));
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("الخطة غير مكتملة");
      expect(json.gaps).toContain("country");
      expect(rpcCalls).toHaveLength(0);
    });
  });
});
