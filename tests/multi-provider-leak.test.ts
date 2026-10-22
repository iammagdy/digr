import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_CUSTOMER_STRINGS, NO_ROUTE_AR, PLAN_LIMITS_AR, SOURCE_WORDING_AR, whatWeCollectAr } from "../src/lib/multiProvider/copy";
import { STATUS_UNAVAILABLE_AR, STATUS_UNVERIFIED_AR, STATUS_VERIFIED_AR } from "../src/lib/multiProvider/policy";
import { buildMultiProviderCapability } from "../src/functions/shared/multiProviderCapability";
import { CHAIN_CAPABILITY_SLUG, ROUTE_DEFS, routeCodeOf } from "../src/lib/multiProvider/routes";
import { customerFacingCapabilityLabel } from "../src/lib/customerFacingRequestLabels";
import { sanitizeCapabilitiesForLlm } from "../src/functions/shared/capabilityRegistry";

const state = vi.hoisted(() => ({ user: { id: "u1", email: "u@t", app_metadata: {} } as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({ from: () => ({ select: () => ({ eq: () => ({ then: (r: any) => r({ data: [], error: null }) }) }) }) })),
}));

/** What a customer must never see: a provider name, an endpoint or capability id, USD, the model vendor, an internal id, English, an emoji, ASCII digits. */
const LEAK = /firecrawl|context\.?dev|contextdev|treg|icypeas|tikhub|scrapecreators|anthropic|openai|claude|haiku|\bgpt|usd|\$|dollar|دولار|endpoint|capability|https?:|chain:|single:|r[0-9a-f]{8}\b|job_|quote_|cost_usd|micro/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const LATIN = /[A-Za-z]/;
const ASCII_DIGIT = /[0-9]/;

describe("customer-facing words of the multi-provider feature", () => {
  it("every sentence is Arabic only, with Arabic-Indic digits, no emoji, and none of the words a customer must never see", () => {
    const all = ALL_CUSTOMER_STRINGS();
    expect(all.length).toBeGreaterThan(10);
    for (const s of all) {
      expect(s, s).toMatch(/[؀-ۿ]/);
      expect(s, s).not.toMatch(LEAK);
      expect(s, s).not.toMatch(EMOJI);
      expect(s, s).not.toMatch(LATIN);
      expect(s, s).not.toMatch(ASCII_DIGIT);
    }
    for (const s of [STATUS_VERIFIED_AR, STATUS_UNVERIFIED_AR, STATUS_UNAVAILABLE_AR]) { expect(s).toMatch(/^[؀-ۿ ]+$/); }
  });

  it("the source wording is «مصادر متاحة», and the plan card states what is collected, the volume and the honest limits BEFORE approval", () => {
    expect(SOURCE_WORDING_AR).toBe("مصادر متاحة");
    const line = whatWeCollectAr({ count: 50, withEmail: true, withPhone: false, withDecisionMaker: false, industry: "مقاولات", country: "مصر" });
    expect(line).toContain("٥٠");
    expect(line).toContain("البريد الإلكتروني المهني");
    expect(line).not.toContain("الهاتف");
    expect(line).toContain(SOURCE_WORDING_AR);
    const limits = PLAN_LIMITS_AR.join(" ");
    expect(limits).toMatch(/قد لا يتوفر البريد الإلكتروني أو الهاتف لبعض الشركات/);
    expect(limits).toMatch(/لا نضمن دقة تامة/);
    expect(limits).toMatch(/لا نجمع عناوين المنازل/);
    expect(limits).toMatch(/صفحة تتطلب تسجيل دخول/);
    expect(NO_ROUTE_AR).not.toMatch(LEAK);
  });

  it("the capability a customer's plan can carry has an Arabic name and description and a customer label without provider words or people wording", () => {
    const cap = buildMultiProviderCapability();
    for (const text of [cap.nameAr, cap.descriptionAr, customerFacingCapabilityLabel(CHAIN_CAPABILITY_SLUG)]) {
      expect(text).not.toMatch(LEAK);
      expect(text).not.toMatch(LATIN);
    }
    expect(customerFacingCapabilityLabel(CHAIN_CAPABILITY_SLUG)).not.toBe("صناع القرار والمسؤولين");
    // what the assistant is given about it carries no endpoint id, no USD and no provider
    const forModel = JSON.stringify(sanitizeCapabilitiesForLlm([cap]));
    expect(forModel).not.toMatch(/mp\.business|firecrawl|context\.?dev|treg|usd|unitCostUsd|tregEndpointId/i);
  });

  it("the route code a plan item carries is opaque: it names no provider and is not the route id", () => {
    for (const r of ROUTE_DEFS) {
      const code = routeCodeOf(r.id);
      expect(code).toMatch(/^r[0-9a-f]{8}$/);
      expect(code).not.toContain(r.id);
      expect(code).not.toMatch(/firecrawl|contextdev|treg/);
    }
    expect(new Set(ROUTE_DEFS.map((r) => routeCodeOf(r.id))).size).toBe(ROUTE_DEFS.length);
  });
});

// ---- customer routes and pages never carry the admin call-log fields -----------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");

/** Everything that serves or renders a CUSTOMER: public pages, the customer dashboard, customer API routes and customer components. */
function customerFiles(): string[] {
  const files = [...walk(path.join(ROOT, "src/app")), ...walk(path.join(ROOT, "src/components"))].map(rel);
  return files.filter((f) =>
    !f.startsWith("src/app/admin/") && !f.startsWith("src/app/api/admin/") && !f.startsWith("src/app/api/worker/") && !f.startsWith("src/app/api/cron/") &&
    !f.startsWith("src/components/admin/"));
}
/** The admin call log's own vocabulary: the table, the reader, the registry of providers and prices, the Arabic internal labels. */
const ADMIN_VOCABULARY = /provider_costs|provider-calls|multiProvider\/callLog|CallLogRow|capabilityLabelAr|PROVIDER_FACTS|multiProvider\/catalog|FIRECRAWL_USD_PER_CREDIT|CONTEXTDEV_USD_PER_CREDIT|firecrawl|contextdev|context\.dev/i;

describe("customer routes and pages do not touch the admin call log or the provider registry", () => {
  it("no customer-facing source file mentions the cost table, the call log, the provider registry or either new provider", () => {
    const offenders = customerFiles().filter((f) => ADMIN_VOCABULARY.test(readFileSync(path.join(ROOT, f), "utf8")));
    // the only customer-side files that may import the multi-provider code are the plan/quote writer path (server) and the copy module; none is a route or a page
    expect(offenders).toEqual([]);
  });

  it("the admin call log route and component exist only in the admin tree, and the route checks the admin first", () => {
    const route = readFileSync(path.join(ROOT, "src/app/api/admin/provider-calls/route.ts"), "utf8");
    expect(route.indexOf("authenticateAdmin")).toBeGreaterThan(-1);
    expect(route.indexOf("authenticateAdmin")).toBeLessThan(route.indexOf("readProviderCallLog("));
    expect(rel(path.join(ROOT, "src/components/admin/ProviderCallLog.tsx"))).toMatch(/^src\/components\/admin\//);
    const importers = walk(path.join(ROOT, "src")).map(rel).filter((f) => /ProviderCallLog|provider-calls/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(importers.every((f) => f.startsWith("src/components/admin/") || f.startsWith("src/app/api/admin/") || f.startsWith("src/app/admin/") || f.startsWith("src/lib/server/multiProvider/"))).toBe(true);
  });
});

describe("the customer metadata route, with the feature ON, returns only slugs and no admin field", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.MULTI_PROVIDER_ENABLED; process.env.MULTI_PROVIDER_ENABLED = "true"; });
  afterEach(() => { if (saved === undefined) delete process.env.MULTI_PROVIDER_ENABLED; else process.env.MULTI_PROVIDER_ENABLED = saved; });

  it("lists the chain capability's slug (no provider in it) and nothing else of it", async () => {
    const { GET } = await import("../src/app/api/chat/metadata/route");
    const res = await GET(new NextRequest("http://localhost/api/chat/metadata"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["enabledCapabilitySlugs", "success"]);
    expect(body.enabledCapabilitySlugs).toContain(CHAIN_CAPABILITY_SLUG);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/firecrawl|contextdev|context\.dev|treg|usd|cost|duration|capabilityLabelAr|provider/i);
  });
});
