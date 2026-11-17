import { checkCustomerText } from "../src/lib/agentMission/text";
import { runChainChunk, type ChainDeps, type ChainChunkInput } from "../src/lib/server/multiProvider/chainRunner";
import { createFakeRobotsFetch, defaultFakeWorld } from "../src/lib/server/multiProvider/fakeTransport";
import { createMemoryRecorder } from "./helpers/multiProviderFakes";
import { expectedTargetLineAr, chainShortfallReasonAr } from "../src/lib/multiProvider/copy";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_CUSTOMER_STRINGS,
  NO_ROUTE_AR,
  PLAN_LIMITS_AR,
  SOURCE_WORDING_AR,
  whatWeCollectAr,
  CHAIN_CARD_LIMITS_V2_AR,
  staleReleaseReasonAr,
  operatorReleaseReasonAr,
  chainFailureReasonAr,
  chainZeroDeliveryReasonAr,
  chainStopProgressLineAr,
} from "../src/lib/multiProvider/copy";
import { CAPABILITIES } from "../src/lib/multiProvider/catalog";
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

  it("T-1 new chain strings satisfy all customer leak and Arabic rules", () => {
    const all = ALL_CUSTOMER_STRINGS();
    const newStrings = all.slice(16);
    for (const s of newStrings) {
      expect(checkCustomerText(s).issues).toEqual([]);
      expect(s).not.toMatch(LATIN);
      expect(s).not.toMatch(ASCII_DIGIT);
      expect(s).not.toMatch(LEAK);
      expect(s).not.toContain("سجل");
      expect(s).not.toMatch(/لا توجد بيانات|لا يوجد|انتهت البيانات|لا تتوفر/);
    }

    const cut = expectedTargetLineAr({ asked: 50, fitted: 41 });
    const uncut = expectedTargetLineAr({ asked: 50, fitted: 50 });
    expect(cut).toContain("العدد المستهدف تسليمه");
    expect(uncut).toContain("العدد المستهدف تسليمه");
    expect(cut).toContain("من أصل ٥٠");
    for (const forbidden of ["نواصل", "حتى يكتمل", "بالضبط", "لا توجد", "لا يوجد"]) {
      expect(cut).not.toContain(forbidden);
      expect(uncut).not.toContain(forbidden);
    }

    const reasons = [
      chainShortfallReasonAr({ stop: "budget", callCap: null, excluded: 0 }),
      chainShortfallReasonAr({ stop: "no_more_work", callCap: null, excluded: 0 }),
      chainShortfallReasonAr({ stop: null, callCap: "page_cap", excluded: 0 }),
      chainShortfallReasonAr({ stop: null, callCap: "empty_pages", excluded: 0 }),
      chainShortfallReasonAr({ stop: null, callCap: "source_repeats", excluded: 0 }),
    ];
    for (const r of reasons) {
      expect(r.endsWith("لم نصل إليها.")).toBe(true);
    }
    const exclReason = chainShortfallReasonAr({ stop: null, callCap: null, excluded: 3 });
    const neutralReason = chainShortfallReasonAr({ stop: null, callCap: null, excluded: 0 });
    expect(exclReason).toContain("استُبعد ٣ شركات");
    expect(neutralReason).toBe("لم يصلنا سبب محدد لتوقف المعالجة قبل اكتمال العدد.");
  });

  it("T-N customer never sees a provider name in customer-visible strings, including real error paths", async () => {
    // 1. Gather all customer strings
    const gathered: string[] = [
      ...ALL_CUSTOMER_STRINGS(),
      ...CHAIN_CARD_LIMITS_V2_AR,
      staleReleaseReasonAr(1),
      staleReleaseReasonAr(45),
      staleReleaseReasonAr(25000),
      operatorReleaseReasonAr(1),
      operatorReleaseReasonAr(45),
      operatorReleaseReasonAr(25000),
    ];

    // Failure reasons and stops
    const stops = ["budget", "coverage_end", "sources_limited", "stalled", "work_limit", "no_more_work", null] as const;
    for (const stop of stops) {
      gathered.push(chainShortfallReasonAr({ stop, callCap: null, excluded: 0 }));
      gathered.push(chainShortfallReasonAr({ stop, callCap: null, excluded: 2 }));
      gathered.push(chainShortfallReasonAr({ stop, callCap: null, excluded: 0, skippedOrigins: 2 }));
      gathered.push(chainZeroDeliveryReasonAr({ target: 10, stop }));
      if (stop) gathered.push(chainStopProgressLineAr(stop as any));
    }

    // ok:false terminals
    for (const kind of ["spend", "cursor", "lease"] as const) {
      gathered.push(chainFailureReasonAr(kind));
    }

    // 2. Simulated provider error strings that must NEVER leak to customer strings
    const providerErrors = [
      "Tomba rate limit",
      "TREG route_max_cost firecrawl 402",
      new Error("Context.dev unreachable").message,
      JSON.stringify({ error: "Context.dev service unavailable", provider: "contextdev" }),
      JSON.stringify({ error: "firecrawl credits exhausted", provider: "firecrawl" }),
    ];

    for (const errStr of providerErrors) {
      for (const s of gathered) {
        expect(s).not.toContain(errStr);
      }
    }

    // 3. Delivered-row cells including source_page
    const sampleCells = [
      "شركة الأمل للمقاولات",
      "info@alamal.com",
      "+201000000001",
      "https://alamal.com/contact", // source_page
      "مصر",
      "مقاولات",
    ];
    for (const cell of sampleCells) {
      expect(cell).not.toMatch(/firecrawl|contextdev|context\.dev|treg|tomba|icypeas/i);
    }

    // 4. Forbidden regex
    const FORBIDDEN_WORDS = /treg|tomba|icypeas|firecrawl|context\.?dev|hunter|apollo|blitz|aviato|enrichlayer|serp|reoon/i;

    // Read catalog providers
    const catalogPath = path.join(ROOT, "data/treg/treg_catalog_sellable.json");
    const catalogData = JSON.parse(readFileSync(catalogPath, "utf-8"));
    const catalogProviders = new Set<string>();
    const endpoints = Array.isArray(catalogData) ? catalogData : catalogData.endpoints ?? [];
    for (const ep of endpoints) {
      if (ep.provider && typeof ep.provider === "string") {
        catalogProviders.add(ep.provider.toLowerCase());
      }
    }

    const capabilityWords = new Set<string>();
    for (const cap of CAPABILITIES) {
      if (cap.provider) capabilityWords.add(cap.provider.toLowerCase());
      if (cap.id) capabilityWords.add(cap.id.toLowerCase());
    }

    // Assert none matches forbidden words, catalog providers, or capability words
    for (const text of gathered) {
      expect(text).not.toMatch(FORBIDDEN_WORDS);
      for (const p of catalogProviders) {
        if (p.length > 3) {
          expect(text.toLowerCase()).not.toContain(p);
        }
      }
      for (const c of capabilityWords) {
        if (c.length > 3) {
          expect(text.toLowerCase()).not.toContain(c);
        }
      }
    }

    // 5. REAL runtime (plan v9 §5 T-N): the provider errors are INJECTED into the chain runner, and what the customer would read is COLLECTED from it:
    // the activity lines, the failure message of every ok:false terminal, the reason sentences of the stop, the delivered rows, and the watchdog's release message.
    const injected = ["Context.dev service unavailable", "firecrawl credits exhausted", "Tomba rate limit", "TREG route_max_cost firecrawl 402"];
    const customerOutputs: string[] = [];
    const chainInput = (over: Partial<ChainChunkInput> = {}): ChainChunkInput => ({
      jobId: "job_leak", userId: "u1", step: 0, endpointId: "mp", capabilitySlug: CHAIN_CAPABILITY_SLUG, method: "POST",
      params: { routeCode: routeCodeOf("chain:contextdev>firecrawl"), budgetUsd: 1, industry: "مقاولات", country: "مصر", requiredFields: ["work_email"], count: 4 },
      paginationStrategy: "cursor", cursor: null, pageSize: 10, remainingNeeded: 4, targetVolumeMax: 4, deliveredSoFar: 0, deadlineMs: Date.now() + 45_000,
      unitPricePoints: (1 * 5500) / (1.15 * 4), claimLeaseUntil: "2026-11-17T12:00:00.000000+00:00", startIndex: 0, ...over,
    });
    const makeDeps = (events: string[], counters: { web: number; treg: number }, over: Partial<ChainDeps> = {}): ChainDeps => {
      const rec = createMemoryRecorder();
      const world = defaultFakeWorld(4);
      return {
        providerKeys: { treg: "managed", firecrawl: "fc-test-key-123456", contextdev: "cx-test-key-123456" },
        fetchFn: (async () => { counters.web += 1; return new Response(JSON.stringify({ error: injected[0], provider: "contextdev", message: injected[1] }), { status: 500, headers: { "content-type": "application/json" } }); }) as any,
        recorder: rec.recorder,
        robotsFetch: createFakeRobotsFetch(world),
        spentUsdSoFar: async () => rec.spent(),
        emit: async (line) => { events.push(line); },
        tregFn: async () => { throw new Error(injected[2]); },
        tregCall: async () => { counters.treg += 1; return { ok: false, httpStatus: 500, tregCallId: "t", costMicro: 0, latencyMs: 1, data: null, error: injected[2], errorDetails: injected[3], isRouteMaxCost: false, isPlatformBalanceLow: false }; },
        jobSpend: async () => ({ usd: rec.spent(), calls: rec.rows.length }),
        leaseHeld: async () => true,
        jobStartedAtMs: async () => Date.now() - 1000,
        newAttemptId: () => crypto.randomUUID(),
        ...over,
      };
    };

    // 5a. every provider answers with an error that names the provider; the chain runs to its end
    const eventsA: string[] = [];
    const countersA = { web: 0, treg: 0 };
    const depsA = makeDeps(eventsA, countersA);
    let cursorA: string | null = null;
    let lastA: Awaited<ReturnType<typeof runChainChunk>> | null = null;
    const rowsA: Record<string, any>[] = [];
    for (let step = 0; step < 8; step++) {
      lastA = await runChainChunk(chainInput({ cursor: cursorA, step }), depsA);
      rowsA.push(...lastA.rows);
      if (!lastA.ok || !lastA.nextCursor) break;
      cursorA = lastA.nextCursor;
    }
    expect(countersA.web).toBeGreaterThan(0);          // the injected errors were really sent to the runner
    expect(countersA.treg).toBeGreaterThan(0);
    expect(eventsA.length).toBeGreaterThan(0);
    expect(lastA!.chainStop).toBeTruthy();             // the job ended with a stop, so its reason sentences exist
    customerOutputs.push(...eventsA, chainZeroDeliveryReasonAr({ target: 4, stop: lastA!.chainStop as any }), chainShortfallReasonAr({ stop: lastA!.chainStop as any, callCap: null, excluded: 0 }));
    if (lastA!.errorMessageAr) customerOutputs.push(lastA!.errorMessageAr);
    for (const r of rowsA) for (const v of Object.values(r)) customerOutputs.push(String(v));

    // 5b. the ok:false terminals: the spend cannot be read, the lease is lost
    for (const [over, expected] of [
      [{ jobSpend: async () => { throw new Error(injected[0]); } }, chainFailureReasonAr("spend")],
      [{ leaseHeld: async () => false }, chainFailureReasonAr("lease")],
    ] as const) {
      const outB = await runChainChunk(chainInput(), makeDeps([], { web: 0, treg: 0 }, over as Partial<ChainDeps>));
      expect(outB.ok).toBe(false);
      expect(outB.errorMessageAr).toBe(expected);
      customerOutputs.push(String(outB.errorMessageAr));
    }

    // 5c. the REAL watchdog route: the release message it writes for a stale started job
    const supabaseWd = await import("../src/lib/supabase/server");
    const previousImpl = vi.mocked(supabaseWd.createAdminClient).getMockImplementation();
    const rpcLog: Array<{ name: string; args: any }> = [];
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const staleJob = { id: "job_leak", user_id: "u1", status: "running", step: 3, delivered_units: 4, target_volume_max: 4, lease_until: oldTime, updated_at: oldTime };
    vi.mocked(supabaseWd.createAdminClient).mockImplementation((() => ({
      rpc: async (name: string, args: any) => { rpcLog.push({ name, args }); return { data: { success: true, released_credits: 100, already_released: false }, error: null }; },
      auth: { admin: {} },
      storage: { from: () => ({ list: async () => ({ data: [] }), remove: async () => ({}) }) },
      from: (table: string) => {
        const api: any = { select: () => api, eq: () => api, in: () => api, or: () => api, not: () => api, lte: () => api, lt: () => api, order: () => api, limit: () => api, maybeSingle: async () => ({ data: null, error: null }), insert: async () => ({ error: null }), delete: () => api, update: () => api, then: (resolve: any) => resolve({ data: table === "jobs" ? [staleJob] : [], error: null }) };
        return api;
      },
    })) as any);
    const savedSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "leak-secret";
    try {
      const { GET } = await import("../src/app/api/cron/watchdog/route");
      const wd = await GET(new NextRequest("http://localhost/api/cron/watchdog", { headers: { authorization: "Bearer leak-secret" } }));
      expect(wd.status).toBe(200);
    } finally {
      if (savedSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = savedSecret;
      if (previousImpl) vi.mocked(supabaseWd.createAdminClient).mockImplementation(previousImpl);
    }
    const wdRelease = rpcLog.filter((c) => c.name === "release_job_atomic");
    expect(wdRelease).toHaveLength(1);
    expect(wdRelease[0].args.p_error_message).toBe(staleReleaseReasonAr(4));
    customerOutputs.push(String(wdRelease[0].args.p_error_message));

    // 5d. nothing the customer would read carries a provider name, an id, a vendor, an English word or an injected provider error
    expect(customerOutputs.length).toBeGreaterThan(6);
    for (const out of customerOutputs) {
      expect(out).not.toMatch(LEAK);
      expect(out).not.toMatch(FORBIDDEN_WORDS);
      for (const e of injected) expect(out.toLowerCase()).not.toContain(e.toLowerCase());
    }
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
