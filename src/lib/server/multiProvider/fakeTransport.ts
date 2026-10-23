import { companyDomain, type RobotsFetch } from "../../multiProvider/policy";
import type { FetchFn } from "./adapterTypes";

/**
 * The fake data providers of the multi-provider feature: Firecrawl and Context.dev answer from a small deterministic world of
 * companies, and every site has a robots.txt. No network, no key, no cost. It extends the guarded fake provider of the pressure test (see the guard module in this folder's parent):
 * the production code asks `getProviderTransport(fakeActive)`, which returns the real `fetch` unless the guard says the fake is active (a
 * PREVIEW deployment on a non-production database with PRESSURE_FAKE_PROVIDER=on). Tests inject `createFakeFetch(...)` directly.
 */

export interface FakeCompany {
  name: string;
  domain: string;
  /** Email on the company's own domain, shown as a mailto link on the contact page. */
  email?: string;
  /** An email whose domain is NOT the company's (an agency, a gmail address): it must stay unverified. */
  foreignEmail?: string;
  phone?: string;
  /** The site answers 403 / WEBSITE_BLOCKED to a read. */
  blocked?: boolean;
  /** The homepage links no contact page. */
  noContactPage?: boolean;
  /** Team page with these leaders (served as structured JSON). */
  leaders?: Array<{ name: string; title: string }>;
  /** robots.txt text (default: allow everything). */
  robots?: string;
  /** The contact page path (default /contact). */
  contactPath?: string;
}

export interface FakeScenario {
  /** A provider that answers every call with this HTTP status. */
  failProvider?: Partial<Record<"firecrawl" | "contextdev", number>>;
  /** Providers that answer search/scrape with success but no content. */
  emptyProvider?: Partial<Record<"firecrawl" | "contextdev", boolean>>;
  /** Credits remaining reported by the usage endpoints. */
  creditsRemaining?: number;
  /** A key the fake accepts; any other key is answered 401. */
  validKey?: string;
}

export interface FakeCallLog { provider: "firecrawl" | "contextdev"; operation: "search" | "map" | "scrape" | "scrape_json" | "usage"; url: string; status: number; auth: string }

export function defaultFakeWorld(count = 12): FakeCompany[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      name: `شركة اختبار ${n}`,
      domain: `fakeco${n}.net`,
      email: n % 3 === 0 ? undefined : `info@fakeco${n}.net`,
      phone: n % 2 === 0 ? `+2010000000${String(n).padStart(2, "0")}` : undefined,
    };
  });
}

const page = (company: FakeCompany, path: string): { markdown: string; links: string[] } => {
  const contact = company.contactPath ?? "/contact";
  if (path === "/" || path === "") {
    const links = company.noContactPage ? ["/products", "/about-products"] : [contact, "/products", company.leaders?.length ? "/team" : "/products"];
    return { markdown: `# ${company.name}\n\nمرحبًا بكم في ${company.name}.\n${links.map((l) => `[${l.slice(1)}](${l})`).join(" ")}\n`, links };
  }
  if (path === contact) {
    const lines = [`# تواصل معنا`, `${company.name}`];
    const links: string[] = [];
    if (company.email) { lines.push(`[${company.email}](mailto:${company.email})`); links.push(`mailto:${company.email}`); }
    if (company.foreignEmail) { lines.push(`وكالتنا: ${company.foreignEmail}`); }
    if (company.phone) { lines.push(`هاتف: ${company.phone}`); links.push(`tel:${company.phone}`); }
    return { markdown: lines.join("\n"), links };
  }
  if (path === "/team") return { markdown: `# فريق القيادة`, links: [] };
  return { markdown: "", links: [] };
};

export function createFakeFetch(world: FakeCompany[], scenario: FakeScenario = {}, log: FakeCallLog[] = []): FetchFn & { log: FakeCallLog[]; world: FakeCompany[] } {
  const find = (host: string) => world.find((c) => host === c.domain || host.endsWith(`.${c.domain}`));
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fn = (async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const u = new URL(url);
    const provider: "firecrawl" | "contextdev" = u.hostname.includes("firecrawl") ? "firecrawl" : "contextdev";
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const record = (operation: FakeCallLog["operation"], status: number) => { log.push({ provider, operation, url, status, auth }); };
    const operation: FakeCallLog["operation"] = /credit-usage|org\/usage/.test(u.pathname) ? "usage" : /\/search$/.test(u.pathname) ? "search" : /\/map$|\/urls$/.test(u.pathname) ? "map" : body?.formats?.json || (Array.isArray(body?.formats) && body.formats.some((f: any) => f?.type === "json")) ? "scrape_json" : "scrape";

    if (scenario.validKey && auth !== `Bearer ${scenario.validKey}`) { record(operation, 401); return json(401, provider === "contextdev" ? { message: "unauthorized", error_code: "UNAUTHORIZED", request_id: "r" } : { success: false, error: "Unauthorized" }); }
    const forced = scenario.failProvider?.[provider];
    if (forced) { record(operation, forced); return json(forced, provider === "contextdev" ? { message: "failed", error_code: forced === 429 ? "RATE_LIMITED" : forced === 402 ? "USAGE_EXCEEDED" : "INTERNAL_ERROR", request_id: "r" } : { success: false, error: "failed" }); }

    if (operation === "usage") {
      record(operation, 200);
      return provider === "firecrawl"
        ? json(200, { success: true, data: { remainingCredits: scenario.creditsRemaining ?? 4321, planCredits: 5000, billingPeriodStart: "2026-10-01T00:00:00Z", billingPeriodEnd: "2026-11-01T00:00:00Z" } })
        : json(200, { credits_remaining: scenario.creditsRemaining ?? 4321, period: { start: "2026-10-01T00:00:00Z", credits_used: 100 }, next_refill: { at: "2026-11-01T00:00:00Z", credits: 7500 }, auto_topup: { enabled: false, credits_used_this_period: 0, monthly_budget_credits: null }, key_metadata: { credits_consumed: 0, credits_remaining: scenario.creditsRemaining ?? 4321 }, request_id: "r" });
    }

    if (operation === "search") {
      record(operation, 200);
      const empty = scenario.emptyProvider?.[provider];
      const limit = Math.max(1, Math.min(100, Number(body.limit ?? body.numResults ?? 10)));
      const hits = empty ? [] : world.slice(0, limit).map((c) => ({ url: `https://www.${c.domain}/`, title: `${c.name} | الصفحة الرئيسية`, description: `موقع ${c.name}` }));
      const credits = hits.length === 0 ? 0 : Math.ceil(hits.length / 10) * (provider === "firecrawl" ? 2 : 1);
      return provider === "firecrawl"
        ? json(200, { success: true, data: { web: hits }, id: "s", creditsUsed: credits })
        : json(200, { results: hits, partial: false, query: body.query, key_metadata: { credits_consumed: credits, credits_remaining: 1000 }, request_id: "r" });
    }

    if (operation === "map") { record(operation, 200); return provider === "firecrawl" ? json(200, { success: true, links: [] }) : json(200, { success: true, domain: "x", urls: [], key_metadata: { credits_consumed: 1, credits_remaining: 1000 }, request_id: "r" }); }

    // scrape / scrape_json
    const target = new URL(String(body.url));
    const company = find(target.hostname.replace(/^www\./, ""));
    if (!company) { record(operation, 200); return provider === "firecrawl" ? json(200, { success: true, data: { markdown: "", links: [], metadata: { statusCode: 404, url: String(body.url) } } }) : json(200, { markdown: { requested: true, success: false, data: null, error_code: "WEBSITE_NOT_FOUND" }, url: String(body.url), key_metadata: { credits_consumed: 1, credits_remaining: 1000 }, request_id: "r" }); }
    if (company.blocked) { record(operation, 200); return provider === "firecrawl" ? json(200, { success: true, data: { markdown: "", links: [], metadata: { statusCode: 403, url: String(body.url) } } }) : json(200, { markdown: { requested: true, success: false, data: null, error_code: "WEBSITE_BLOCKED" }, url: String(body.url), key_metadata: { credits_consumed: 1, credits_remaining: 1000 }, request_id: "r" }); }
    const { markdown, links } = page(company, target.pathname);
    const empty = scenario.emptyProvider?.[provider] || (!markdown && operation === "scrape");
    record(operation, 200);
    if (operation === "scrape_json") {
      const people = company.leaders ?? [];
      return provider === "firecrawl"
        ? json(200, { success: true, data: { json: empty ? null : { people }, metadata: { statusCode: 200, url: String(body.url) } } })
        : json(200, { json: { requested: true, success: true, data: empty ? null : { people } }, url: String(body.url), key_metadata: { credits_consumed: empty ? 1 : 5, credits_remaining: 1000 }, request_id: "r" });
    }
    return provider === "firecrawl"
      ? json(200, { success: true, data: { markdown: empty ? "" : markdown, links: empty ? [] : links, metadata: { statusCode: 200, url: String(body.url) } } })
      : json(200, { markdown: { requested: true, success: true, data: empty ? "" : markdown }, url: String(body.url), key_metadata: { credits_consumed: 1, credits_remaining: 1000 }, request_id: "r" });
  }) as FetchFn & { log: FakeCallLog[]; world: FakeCompany[] };
  fn.log = log;
  fn.world = world;
  return fn;
}

/** robots.txt of the fake world: allow everything unless a company says otherwise; an unknown host has none (404). */
export function createFakeRobotsFetch(world: FakeCompany[]): RobotsFetch {
  return async (origin: string) => {
    const host = new URL(origin).hostname.replace(/^www\./, "");
    const company = world.find((c) => host === c.domain || host.endsWith(`.${c.domain}`));
    if (!company) return { status: 404, text: "" };
    return { status: 200, text: company.robots ?? "User-agent: *\nAllow: /\n" };
  };
}

/**
 * Production code asks here. `fakeActive` is the answer of the ONE guard (the guard of the pressure test, read by the worker
 * route, the only place allowed to read it): true only on a PREVIEW deployment against a test database. Otherwise the real network.
 */
export function getProviderTransport(fakeActive: boolean, realFetch: FetchFn = fetch as FetchFn): FetchFn {
  return fakeActive ? createFakeFetch(defaultFakeWorld(30)) : realFetch;
}

export function getRobotsTransport(fakeActive: boolean, realFetch: FetchFn = fetch as FetchFn): RobotsFetch {
  if (fakeActive) return createFakeRobotsFetch(defaultFakeWorld(30));
  return async (origin: string) => {
    const get = (url: string) => realFetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(6000), headers: { Accept: "text/plain", "User-Agent": "DigerBot (+https://diger.tech)" } });
    try {
      let res = await get(`${origin}/robots.txt`);
      // One hop, and only to the same site (www or not): a redirect anywhere else is never followed.
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        let next: URL | null = null;
        try { next = location ? new URL(location, `${origin}/robots.txt`) : null; } catch { next = null; }
        if (!next || next.protocol !== "https:" || companyDomain(next.toString()) !== companyDomain(origin)) return null;
        res = await get(next.toString());
      }
      return { status: res.status, text: res.status >= 200 && res.status < 300 ? (await res.text()).slice(0, 200_000) : "" };
    } catch {
      return null;
    }
  };
}
