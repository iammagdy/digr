import { createMemoryStore, type MemoryStore } from "../../agent/src/memoryStore";
import type { TregCallOptions, TregCallResult } from "../../src/functions/shared/tregClient";
import { SLUGS, TITLES, company } from "./a1World";
export { SLUGS, company };
import { USER_ID, tregResult } from "./agentHarness";

/**
 * STAGE 3: A FAKE WORLD FOR THE CODE-BUILT COMPANIES PLAN (fake companies, fake people, fake contacts: the A1 world's names, never a real person). Every tool of the verified chains answers in the
 * SHAPE of its stored real page (tests/fixtures/live/missions: tomba's `data.companies`, blitzapi's `results`, the finders' `found` / `email` / `phone`, the maps tool's `rows`); what each tool says
 * for a company or a person is chosen by the test (`value`, `empty`, `fail`), so the fallthrough of every cell can be driven. No network, no paid call.
 */
export const LIVE_7539 = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار";
export const TEST_EMAIL = "iam.magdy+1@outlook.com";
export type Answer = "value" | "empty" | "fail";
export interface Stage3World {
  /** The maps tool for a company's HQ phone (default: value). */
  maps?: (slug: string) => Answer;
  /** The e-mail finder for a person (default: value). */
  email?: (slug: string, i: number) => Answer;
  /** The phone finder for a person (default: empty). */
  mobile?: (slug: string, i: number) => Answer;
  /** The companies page (default: the five companies once each). */
  companies?: () => Array<Record<string, unknown>>;
}
const FAILED = (): TregCallResult => tregResult(null, 0, { ok: false, httpStatus: 503, error: "down" });
export const personLink = (slug: string, i: number) => `https://www.linkedin.example/in/${slug}-${i}`;
const slugOf = (o: TregCallOptions): (typeof SLUGS)[number] | undefined => SLUGS.find((s) => JSON.stringify(o.params ?? {}).includes(s));
const personOf = (o: TregCallOptions): { slug: string; i: number } | null => { const m = /\/in\/([a-z]+-em)-(\d+)/.exec(JSON.stringify(o.params ?? {})); return m ? { slug: m[1], i: Number(m[2]) } : null; };

export const stage3Dispatcher = (w: Stage3World = {}) => (o: TregCallOptions): TregCallResult => {
  if (o.endpointId === "tomba.companies.search.reveal") {
    const page = Number((o.params as Record<string, unknown>)?.page ?? 1);
    const list = page > 1 ? [] : w.companies ? w.companies() : SLUGS.map((s, i) => ({ ...company(s, i), phone_number: false }));
    return tregResult({ success: true, data: { companies: list }, meta: { total: list.length, page, limit: 50, pages: 1 } }, page > 1 ? 0 : 0.0089);
  }
  if (o.endpointId === "blitzapi.people.employee-finder") {
    const s = slugOf(o);
    const page = Number((o.params as Record<string, unknown>)?.page ?? 1);
    if (!s || page > 1) return tregResult({ results: [], page, total_pages: 1 }, 0);
    return tregResult({ results: TITLES[s].slice(0, 4).map((t, i) => ({ full_name: `${["Hossam", "Mona", "Ahmed", "Salma"][i]} ${s.split("-")[0]}`, headline: t, linkedin_url: personLink(s, i) })), page, total_pages: 1 }, 0.00198);
  }
  if (o.endpointId === "blitzapi.people.email.find") {
    const p = personOf(o);
    const a = p ? (w.email ?? (() => "value"))(p.slug, p.i) : "empty";
    return a === "fail" ? FAILED() : tregResult(a === "value" && p ? { found: true, email: `p${p.i}@${p.slug}.com.eg` } : { found: false, email: null }, a === "value" ? 0.000495 : 0);
  }
  if (o.endpointId === "blitzapi.people.phone.find") {
    const p = personOf(o);
    const a = p ? (w.mobile ?? (() => "empty"))(p.slug, p.i) : "empty";
    return a === "fail" ? FAILED() : tregResult(a === "value" && p ? { found: true, phone: `+20 10 0000 00${p.i}${SLUGS.indexOf(p.slug as (typeof SLUGS)[number])}` } : { found: false, phone: null }, a === "value" ? 0.000495 : 0);
  }
  if (o.endpointId === "crawl4ai.google.serp.maps") {
    const s = slugOf(o) ?? SLUGS.find((x) => JSON.stringify(o.params ?? {}).toLowerCase().includes(x.split("-")[0]));
    const a = s ? (w.maps ?? (() => "value"))(s) : "empty";
    if (a === "fail") return FAILED();
    const i = s ? SLUGS.indexOf(s) : -1;
    return tregResult({ rows: a === "value" && s ? [{ place_id: `pl_${s}`, name: company(s, i).name, website: `https://${s}.com.eg/`, phone: `+20 2 2574 000${i + 1}`, address: "Cairo" }] : [] }, a === "value" ? 0.00015 : 0);
  }
  // the verifiers and validators of today's steps (not lookups): no verdict
  return tregResult({}, 0);
};

/** A store whose mission belongs to a TEST account (the plus-alias e-mail, redesign.ts accountIsTest). */
export const testAccountStore = (): MemoryStore => { const s = createMemoryStore(); s.userEmails.set(USER_ID, TEST_EMAIL); return s; };
