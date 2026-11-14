import { afterEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { parseExclusionFile } from "../src/lib/server/exclusionFileParser";
import { compareOrganizations, deduplicateAgainstBaseline } from "../src/lib/server/negativeListEngine";
import {
  CUSTOMER_EXCLUSION_FLAG_KEY,
  EXCLUSION_POSSIBLE_MARK,
  EXCLUSION_SNAPSHOT_PATH,
  EXCLUSION_UNUSABLE_AR,
  ENRICHMENT_NOT_SUPPORTED_AR,
  uploadIntentOf,
  corporateDomainOf,
  exclusionMatcherOf,
  exclusionNotAppliedAr,
  exclusionSnapshotOf,
  organisationOfRow,
  parseExclusionSnapshot,
  type ExclusionSnapshot,
} from "../src/lib/agentMission/customerExclusion";
import { exclusionForCard, agentChatTurn } from "../src/lib/agentMission/chatTurn";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { exclusionAppliesToStage, ingestRows } from "../agent/src/items/ingest";
import { loadApprovedExclusion, missionExclusionReader, withCustomerExclusion } from "../agent/src/customerExclusion";
import { REASON_TEXT_AR, reasonTextAr, zeroDeliveryReasonAr } from "../agent/src/finalize";
import { buildMethodology } from "../agent/src/methodology";
import { EXISTING_REMOVAL_REASONS, isAllowedRemovalRaw } from "../src/lib/agentMission/rawDelivery";
import { checkCustomerText } from "../src/lib/agentMission/text";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import type { MissionRecord } from "../agent/src/types";
import { createMemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { approvingReview, assertReplayInvariants, replay, replayClient, REPLAY_USER } from "./helpers/agentReplay";
import { callIds, companiesPage, emailFound, emailNotFound, employeesPage, lastOutputId, planningFlow, tregResult, type Results } from "./helpers/agentFakeWorld";
const execCalls = (r: Results) => r.filter((x) => x.tool === "treg_call" && x.result.ok === true).map((x) => String(x.result.call_id));
import type { FakeStep } from "../agent/src/fakeDriver";
import { COMPANIES as A1_COMPANIES, PEOPLE as A1_PEOPLE, companiesPage as a1CompaniesPage, peopleOfCompany, pickCompany, planFlow as a1PlanFlow, request as a1Request } from "./helpers/a1World";
import type { TregCallOptions } from "../src/functions/shared/tregClient";

/**
 * PHASE 5.3 (docs/intelligence/PHASE-5-3-AND-6.md): THE CUSTOMER'S EXCLUSION FILE REACHES THE RESULTS, behind `customer_exclusion_files_v1` (OFF by default).
 * Offline only: CSV and XLSX fixtures go through the real server parser, the snapshot, the deterministic matcher, the one item check of the worker, the planning and execution wiring, and a whole replayed mission.
 */
afterEach(() => { vi.unstubAllGlobals(); });

const OTHER_USER = "00000000-0000-0000-0000-0000000000bb";
const csv = (text: string) => Buffer.from(text, "utf-8");
async function xlsx(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("قائمة");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const fileOf = async (buf: Buffer, type: "csv" | "xlsx", name = "exclude.xlsx") => { const spec = await parseExclusionFile(buf, type); return { name, baselineRowCount: spec.baselineRowCount, normalizedEntities: spec.normalizedEntities }; };
const snap = (entities: Array<{ name: string; domain?: string; crNumber?: string }>): ExclusionSnapshot => exclusionSnapshotOf({ name: "x.csv", normalizedEntities: entities })!;

// ------------------------------------------------------------------------------------------------ the snapshot
describe("the snapshot of the server-parsed file", () => {
  it("keeps only organisation identifiers, removes repeats, pins the exact list by its digest", async () => {
    const file = await fileOf(csv("اسم الشركة,الموقع,السجل التجاري,البريد الشخصي\nأوراسكوم للإنشاءات,https://www.orascom.com/en,١٢٣٤٥,nobody@gmail.example\nأوراسكوم للإنشاءات,orascom.com,12345,\nبتروجت,petrojet.com.eg,,\n"), "csv");
    const s = exclusionSnapshotOf(file)!;
    expect(s.entities).toEqual([{ name: "أوراسكوم للإنشاءات", domain: "orascom.com", crNumber: "12345" }, { name: "بتروجت", domain: "petrojet.com.eg" }]);
    expect(JSON.stringify(s)).not.toContain("gmail");
    expect(s.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(exclusionSnapshotOf(file)!.digest).toBe(s.digest);
    expect(parseExclusionSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
  it("reads an XLSX fixture through the real parser", async () => {
    const s = exclusionSnapshotOf(await fileOf(await xlsx([["Company Name", "Website"], ["Elsewedy Electric", "elsewedyelectric.com"], ["Hassan Allam Holding", "www.hassanallam.com"]]), "xlsx"))!;
    expect(s.entities.map((e) => e.domain)).toEqual(["elsewedyelectric.com", "hassanallam.com"]);
  });
  it("an empty file, a file of blank rows and a file with no usable name are never a list", async () => {
    expect(exclusionSnapshotOf(await fileOf(csv(""), "csv"))).toBeNull();
    expect(exclusionSnapshotOf(await fileOf(csv("اسم الشركة\n\n\n"), "csv"))).toBeNull();
    expect(exclusionSnapshotOf(await fileOf(csv("اسم الشركة\nا\n"), "csv"))).toBeNull();
    expect(exclusionSnapshotOf(null)).toBeNull();
    expect(exclusionSnapshotOf({ name: "x", normalizedEntities: "not a list" })).toBeNull();
  });
  it("an invalid (corrupt) spreadsheet is refused by the parser before any snapshot exists", async () => {
    await expect(parseExclusionFile(Buffer.from("PK\u0003\u0004 not a workbook"), "xlsx")).rejects.toBeTruthy();
  });
  it("a tampered stored list (one name changed, a digest edited, a wrong shape) is refused whole, never read partly", () => {
    const s = snap([{ name: "أوراسكوم" }, { name: "بتروجت" }]);
    expect(parseExclusionSnapshot({ ...s, entities: [{ name: "أوراسكوم" }, { name: "طلعت مصطفى" }] })).toBeNull();
    expect(parseExclusionSnapshot({ ...s, digest: "0".repeat(64) })).toBeNull();
    expect(parseExclusionSnapshot({ ...s, v: 2 })).toBeNull();
    expect(parseExclusionSnapshot({ ...s, entities: [{ name: 5 }] })).toBeNull();
    expect(parseExclusionSnapshot([])).toBeNull();
  });
  it("a shared host or a free mailbox is never a company's domain", () => {
    expect(corporateDomainOf("https://facebook.com/acme")).toBeNull();
    expect(corporateDomainOf("acme.wixsite.com")).toBeNull();
    expect(corporateDomainOf("gmail.com")).toBeNull();
    expect(corporateDomainOf("https://www.linkedin.com/company/acme")).toBeNull();
    expect(corporateDomainOf("https://eg.orascom.com/about?x=1")).toBe("orascom.com");
    expect(corporateDomainOf("shop.petrojet.com.eg")).toBe("petrojet.com.eg");
  });
});

// ------------------------------------------------------------------------------------------------ the matcher
describe("the deterministic matcher (no model)", () => {
  const m = exclusionMatcherOf(snap([
    { name: "شركة أوراسكوم للإنشاءات", domain: "orascom.com" },
    { name: "المقاولون العرب", crNumber: "98765" },
    { name: "Hassan Allam Holding" },
    { name: "النيل للتركيبات الكهربائية" },
    { name: "شركة مقاولات" },
    { name: "Acme", domain: "facebook.com" },
  ]));
  it("exact names, Arabic spelling variants, domains, registration numbers and brand words", () => {
    expect(m.check({ names: ["شركة أوراسكوم للإنشاءات"] })).toEqual({ kind: "excluded", rule: "name" });
    expect(m.check({ names: ["شركه اوراسكوم للانشاءات"] })).toEqual({ kind: "excluded", rule: "name" });
    expect(m.check({ names: ["شَرِكَة أُوراسكوم للإنشاءات"] })).toEqual({ kind: "excluded", rule: "name" });
    expect(m.check({ names: ["Some Other Name"], domain: "https://www.orascom.com/contact" })).toEqual({ kind: "excluded", rule: "domain" });
    expect(m.check({ names: ["x"], crNumber: "٩٨٧٦٥" })).toEqual({ kind: "excluded", rule: "registration" });
    expect(m.check({ names: ["Hassan Allam Holdings Group"] })).toEqual({ kind: "excluded", rule: "brand" });
    expect(m.check({ names: ["النيل للتركيبات الكهربائيه"] })).toEqual({ kind: "excluded", rule: "name" });
  });
  it("an ambiguous resemblance (one shared brand word) is POSSIBLE, never excluded", () => {
    expect(m.check({ names: ["النيل للمقاولات"] })).toEqual({ kind: "possible" });
    expect(m.check({ names: ["Allam Trading"] })).toEqual({ kind: "possible" });
  });
  it("generic words alone never match, and a shared host in the list never excludes every social page", () => {
    expect(m.check({ names: ["شركة مقاولات عامة"] })).toEqual({ kind: "none" });
    expect(m.check({ names: ["Totally Different"], domain: "https://facebook.com/somebody" })).toEqual({ kind: "none" });
    expect(m.check({ names: ["طلعت مصطفى"], domain: "tmg.com.eg" })).toEqual({ kind: "none" });
  });
  it("agrees with the existing negative-list engine on every confirmed match of a fixture matrix", () => {
    const base = [{ name: "شركة أوراسكوم للإنشاءات", domain: "orascom.com" }, { name: "Hassan Allam Holding" }, { name: "بتروجت" }, { name: "المقاولون العرب" }];
    const candidates = [
      { name: "اوراسكوم للانشاءات" }, { name: "Orascom Construction", domain: "orascom.com" }, { name: "Hassan Allam" }, { name: "Hassan Allam Holding" }, { name: "بتروجيت" },
      { name: "شركة بتروجت" }, { name: "المقاولون العرب" }, { name: "العرب للمقاولات" }, { name: "طلعت مصطفى" }, { name: "Allam Group" },
    ];
    const mm = exclusionMatcherOf(snap(base));
    const engine = deduplicateAgainstBaseline(candidates, base);
    for (const c of candidates) {
      const expected = engine.confirmedDuplicates.includes(c) ? "excluded" : engine.ambiguousMatches.includes(c) ? "possible" : "none";
      expect(mm.check({ names: [c.name], domain: c.domain }).kind, c.name).toBe(expected);
    }
    // and the single-pair engine says the same for a domain match
    expect(compareOrganizations({ name: "x", domain: "orascom.com" }, base[0]).status).toBe("CONFIRMED_DUPLICATE");
  });
  it("checks 5,000 listed companies against 2,000 rows fast (indexed, not pair by pair)", () => {
    const big = exclusionMatcherOf(snap(Array.from({ length: 5000 }, (_, i) => ({ name: `Brand${i} Trading`, domain: `brand${i}.com` }))));
    const t = Date.now();
    let excluded = 0;
    for (let i = 0; i < 2000; i += 1) if (big.check({ names: [`Brand${i * 3} Trading`] }).kind === "excluded") excluded += 1;
    expect(excluded).toBe(1667);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("the organisation of a stored row", () => {
  it("a person row is matched by its EMPLOYER only, never the person's own name or job title", () => {
    const o = organisationOfRow({ id: "p1", name: "Orascom", title: "Hassan Allam Holding", company: "Elsewedy Electric", company_domain: "elsewedy.com" }, { people: true });
    expect(o.names).toEqual(["Elsewedy Electric"]);
    expect(o.domain).toBe("elsewedy.com");
  });
  it("a nested employer record and a combined name are read", () => {
    expect(organisationOfRow({ company: { name: "Petrojet", website: "https://petrojet.com.eg" } }, { people: true })).toMatchObject({ names: ["Petrojet"], domain: "petrojet.com.eg" });
    expect(organisationOfRow({ text: "Mitsubishi Elevators \\ Melco Egypt" }, { people: false, nameKeys: ["text"] }).names).toContain("Mitsubishi Elevators");
  });
  it("internal marks are never read", () => {
    expect(organisationOfRow({ _src: "orascom.com", name: "X" }, { people: false }).domain).toBeNull();
 
    // a nested record under an internal key is skipped as well
    expect(organisationOfRow({ _company: { name: "Listed Co", website: "listed.com" }, name: "X" }, { people: false })).toMatchObject({ names: ["X"], domain: null });
  });
  it("the snapshot is capped at the route's maximum (5,000 distinct companies)", () => {
    const many = Array.from({ length: 5003 }, (_, i) => ({ name: `Company Number ${i} Holdings`, domain: `co${i}.com` }));
    const s = exclusionSnapshotOf({ name: "big.csv", normalizedEntities: many })!;
    expect(s.entities.length).toBe(5000);
    expect(s.entities[4999].name).toBe("Company Number 4999 Holdings");
  });
});

// ------------------------------------------------------------------------------------------------ the one item check (ingest)
const companyStage = (extra: Record<string, unknown> = {}): PricedStage => ({
  key: "companies", title_ar: "الشركات", endpoint_id: "e.companies.search", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true,
  columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }], sample_rows: [], measured_by: [], ...extra,
} as unknown as PricedStage);
const postsStage = (): PricedStage => ({ key: "posts", title_ar: "المنشورات", endpoint_id: "e.posts", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [], measured_by: [] } as unknown as PricedStage);
const LIST = snap([{ name: "أوراسكوم للإنشاءات", domain: "orascom.com" }, { name: "النيل للتركيبات الكهربائية" }, { name: "Hassan Allam Holding" }]);
const planWith = (s: PricedStage, applies = true): PricedPlan => ({ summary_ar: "x", stages: [s], price: { deliveredRows: s.planned_rows }, customer_exclusion: { digest: LIST.digest, entities: LIST.entities.length, applies } } as unknown as PricedPlan);
const rowsA = [
  { id: "1", name: "اوراسكوم للانشاءات", website: "" },
  { id: "2", name: "شركة الدلتا للصناعات", website: "delta-ind.com" },
  { id: "3", name: "Some Brand", website: "https://www.orascom.com" },
  { id: "4", name: "النيل للمقاولات", website: "" },
  { id: "5", name: "طلعت مصطفى", website: "tmg.com.eg" },
];
async function ingestAll(batches: Array<Array<Record<string, unknown>>>, opts: { plan?: PricedPlan; stage?: PricedStage; exclusion?: ReturnType<typeof exclusionMatcherOf> | null } = {}) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, "msn_excl01");
  const s = opts.stage ?? companyStage();
  const plan = opts.plan ?? planWith(s);
  const exclusion = opts.exclusion === undefined ? exclusionMatcherOf(LIST) : opts.exclusion;
  const results = [];
  for (const b of batches) results.push(await ingestRows({ items, plan, addEvent: async () => undefined, ...(exclusion ? { exclusion } : {}) }, s, b, { silent: true, idField: null }));
  return { items, results, store };
}

describe("the worker's one item check refuses every excluded company", () => {
  it("excluded rows are never accepted, counted or delivered; possible matches are delivered and marked", async () => {
    const { items, results } = await ingestAll([rowsA]);
    const accepted = items.acceptedRows("companies").map((r) => String(r.id)).sort();
    expect(accepted).toEqual(["2", "4", "5"]);
    expect(items.counts("companies").accepted).toBe(3);
    expect(items.acceptedRows("companies").find((r) => r.id === "4")![EXCLUSION_POSSIBLE_MARK]).toBe(true);
    expect(items.acceptedRows("companies").find((r) => r.id === "2")![EXCLUSION_POSSIBLE_MARK]).toBeUndefined();
    expect(results[0].rejected_by_customer_exclusion).toBe(2);
    const snapshotState = items.stage("companies");
    expect([...snapshotState.items.values()].filter((it) => it.state === "excluded").map((it) => it.reason)).toEqual(["customer_exclusion", "customer_exclusion"]);
  });
  it("a retried page (the same rows again) and a fallback source (the same companies under new ids and other fields) cannot bring them back", async () => {
    const fallback = [{ id: "fb-1", name: "شركه اوراسكوم للإنشاءات" }, { id: "fb-2", name: "Hassan Allam Holdings" }, { id: "fb-3", name: "x", website: "orascom.com/ar" }, { id: "fb-4", name: "مصنع جديد", website: "new.example" }];
    const { items } = await ingestAll([rowsA, rowsA, fallback, rowsA]);
    expect(items.acceptedRows("companies").map((r) => String(r.id)).sort()).toEqual(["2", "4", "5", "fb-4"]);
    expect(items.counts("companies").accepted).toBe(4);
    expect(items.acceptedRows("companies").some((r) => /orascom|اوراسكوم|أوراسكوم|Allam/i.test(`${r.name} ${r.website}`))).toBe(false);
  });
  it("duplicate companies in one page are one item, and an excluded one stays excluded", async () => {
    const { items } = await ingestAll([[{ id: "a", name: "أوراسكوم للإنشاءات" }, { id: "a", name: "أوراسكوم للإنشاءات" }, { id: "b", name: "شركة جديدة" }, { id: "b", name: "شركة جديدة" }]]);
    expect(items.acceptedRows("companies").map((r) => r.id)).toEqual(["b"]);
    expect(items.counts("companies").duplicates).toBe(2);
  });
  it("a people stage is matched by the person's employer", async () => {
    const people = { ...companyStage(), key: "people", title_ar: "الأشخاص", endpoint_id: "e.people.search", capability: "people.search", columns: [{ key: "name", title_ar: "الاسم" }, { key: "company", title_ar: "الشركة" }, { key: "job_title", title_ar: "المسمى" }] } as unknown as PricedStage;
    expect(exclusionAppliesToStage(people)).toBe(true);
    const { items } = await ingestAll([[{ id: "p1", name: "Hassan Allam", company: "Petrojet", job_title: "Engineer" }, { id: "p2", name: "Mona Adel", company: "أوراسكوم للإنشاءات", job_title: "CEO" }]], { stage: people, plan: planWith(people) });
    expect(items.acceptedRows("people").map((r) => r.id)).toEqual(["p1"]);
  });
  it("FAIL CLOSED: a plan approved with a list is never ingested without exactly that list", async () => {
    await expect(ingestAll([rowsA], { exclusion: null })).rejects.toThrow("customer_exclusion_unavailable");
    await expect(ingestAll([rowsA], { exclusion: exclusionMatcherOf(snap([{ name: "Other" }])) })).rejects.toThrow("customer_exclusion_unavailable");
  });
  it("no mark, or a mark that does not apply, or a stage it does not apply to: today's behaviour exactly", async () => {
    const s = companyStage();
    const noMark = { summary_ar: "x", stages: [s], price: { deliveredRows: 5 } } as unknown as PricedPlan;
    expect((await ingestAll([rowsA], { plan: noMark, exclusion: null })).items.counts("companies").accepted).toBe(5);
    expect((await ingestAll([rowsA], { plan: planWith(s, false), exclusion: null })).items.counts("companies").accepted).toBe(5);
    const posts = postsStage();
    expect(exclusionAppliesToStage(posts)).toBe(false);
    const r = await ingestAll([[{ id: "1", text: "أوراسكوم للإنشاءات" }]], { stage: posts, plan: planWith(posts), exclusion: null });
    expect(r.items.counts("posts").accepted).toBe(1);
    // a child stage: its parent was already checked
    expect(exclusionAppliesToStage({ ...s, parent_key: "x" } as PricedStage)).toBe(false);
  });
  it("the stored rows keep the row shape: no exclusion key is written on a row when the mark is absent", async () => {
    const s = companyStage();
    const noMark = { summary_ar: "x", stages: [s], price: { deliveredRows: 5 } } as unknown as PricedPlan;
    const { items } = await ingestAll([rowsA], { plan: noMark, exclusion: null });
    expect(items.acceptedRows("companies").every((r) => !(EXCLUSION_POSSIBLE_MARK in r))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ planning and execution wiring
const mission = (userId = REPLAY_USER): MissionRecord => ({ id: "msn_excl02", user_id: userId } as MissionRecord);
const ON_FOR_USER = { [CUSTOMER_EXCLUSION_FLAG_KEY]: { user_ids: [REPLAY_USER] } };

describe("planning pins the list on the plan the customer approves (switch ON only)", () => {
  it("switch OFF (default), or ON for another account only: the same plan object, the card is never read, nothing is written", async () => {
    const store = createMemoryStore();
    const read = vi.fn(async () => LIST);
    const plan = planWith(companyStage());
    delete (plan as any).customer_exclusion;
    expect(await withCustomerExclusion({ plan, mission: mission(), store, settings: {}, read })).toBe(plan);
    expect(await withCustomerExclusion({ plan, mission: mission(OTHER_USER), store, settings: ON_FOR_USER, read })).toBe(plan);
    expect(await withCustomerExclusion({ plan, mission: mission(), store, settings: { [CUSTOMER_EXCLUSION_FLAG_KEY]: "off" }, read })).toBe(plan);
    expect(read).not.toHaveBeenCalled();
    expect(store.files.size).toBe(0);
  });
  it("switch ON: the private copy is written, the digest and size are on the plan, and the card says how it applies", async () => {
    const store = createMemoryStore();
    const plan = planWith(companyStage());
    delete (plan as any).customer_exclusion;
    const out = await withCustomerExclusion({ plan, mission: mission(), store, settings: ON_FOR_USER, read: async () => LIST });
    expect(out.customer_exclusion).toEqual({ digest: LIST.digest, entities: 3, applies: true });
    expect(out.notes_ar!.join(" ")).toContain("ملف الاستبعاد");
    expect(JSON.stringify(out)).not.toContain("أوراسكوم");
    expect(out.price).toBe(plan.price);
    expect(parseExclusionSnapshot(JSON.parse(String(await store.getFile("msn_excl02", EXCLUSION_SNAPSHOT_PATH))))).toEqual(LIST);
    for (const line of out.notes_ar!) expect(checkCustomerText(line).issues).toEqual([]);
  });
  it("switch ON with a plan of posts: said not applicable, nothing written, nothing applied", async () => {
    const store = createMemoryStore();
    const plan = { summary_ar: "x", stages: [postsStage()], price: { deliveredRows: 5 } } as unknown as PricedPlan;
    const out = await withCustomerExclusion({ plan, mission: mission(), store, settings: ON_FOR_USER, read: async () => LIST });
    expect(out.customer_exclusion!.applies).toBe(false);
    expect(out.notes_ar!.join(" ")).toContain("لا ينطبق");
    expect(store.files.size).toBe(0);
  });
  it("switch ON with no list on the card: unchanged; a failed or malformed read throws (never a silent «no list»)", async () => {
    const store = createMemoryStore();
    const plan = planWith(companyStage());
    delete (plan as any).customer_exclusion;
    expect(await withCustomerExclusion({ plan, mission: mission(), store, settings: ON_FOR_USER, read: async () => null })).toBe(plan);
    await expect(withCustomerExclusion({ plan, mission: mission(), store, settings: ON_FOR_USER, read: async () => { throw new Error("customer_exclusion_read_failed"); } })).rejects.toThrow();
  });
  it("the real reader reads ONLY the same user's assistant card of the same mission", async () => {
    const calls: Array<[string, unknown]> = [];
    const rows = [{ plan: { agentMissionId: "msn_excl02", customerExclusion: LIST } }];
    const q: any = { select: () => q, eq: (k: string, v: unknown) => { calls.push([k, v]); return q; }, order: () => q, limit: async () => ({ data: rows, error: null }) };
    const read = missionExclusionReader({ from: (t: string) => { expect(t).toBe("messages"); return q; } });
    expect(await read("msn_excl02", REPLAY_USER)).toEqual(LIST);
    expect(calls).toEqual([["user_id", REPLAY_USER], ["role", "assistant"], ["plan->>agentMissionId", "msn_excl02"]]);
    rows[0] = { plan: { agentMissionId: "msn_excl02" } } as any;
    expect(await read("msn_excl02", REPLAY_USER)).toBeNull();
    rows[0] = { plan: { agentMissionId: "msn_excl02", customerExclusion: { ...LIST, digest: "f".repeat(64) } } } as any;
    await expect(read("msn_excl02", REPLAY_USER)).rejects.toThrow("customer_exclusion_malformed");
    const failing: any = { select: () => failing, eq: () => failing, order: () => failing, limit: async () => ({ data: null, error: { message: "boom" } }) };
    await expect(missionExclusionReader({ from: () => failing })("m", REPLAY_USER)).rejects.toThrow("customer_exclusion_read_failed");
  });
  it("execution loads exactly the approved copy; missing or altered is refused", async () => {
    const store = createMemoryStore();
    const mark = { digest: LIST.digest, entities: 3, applies: true };
    expect(await loadApprovedExclusion(store, "m1", mark)).toBeNull();
    await store.putFile("m1", EXCLUSION_SNAPSHOT_PATH, JSON.stringify(LIST), "application/json");
    expect((await loadApprovedExclusion(store, "m1", mark))!.digest).toBe(LIST.digest);
    await store.putFile("m1", EXCLUSION_SNAPSHOT_PATH, JSON.stringify(snap([{ name: "Other" }])), "application/json");
    expect(await loadApprovedExclusion(store, "m1", mark)).toBeNull();
    await store.putFile("m1", EXCLUSION_SNAPSHOT_PATH, "{not json", "application/json");
    expect(await loadApprovedExclusion(store, "m1", mark)).toBeNull();
  });
  it("a DIFFERENT but self-consistent list of the same size is refused (the approved digest is compared, not only the copy's own)", async () => {
    const store = createMemoryStore();
    const mark = { digest: LIST.digest, entities: LIST.entities.length, applies: true };
    const other = snap(LIST.entities.map((e, i) => ({ name: `Unrelated Holding ${i}` })));
    expect(other.entities.length).toBe(LIST.entities.length);
    expect(other.digest).not.toBe(LIST.digest);
    expect(parseExclusionSnapshot(other)).not.toBeNull();
    await store.putFile("m1", EXCLUSION_SNAPSHOT_PATH, JSON.stringify(other), "application/json");
    expect(await loadApprovedExclusion(store, "m1", mark)).toBeNull();
  });
  it("the approved size is compared too: the right list with a mark of another size is refused", async () => {
    const store = createMemoryStore();
    await store.putFile("m1", EXCLUSION_SNAPSHOT_PATH, JSON.stringify(LIST), "application/json");
    expect(await loadApprovedExclusion(store, "m1", { digest: LIST.digest, entities: LIST.entities.length + 1, applies: true })).toBeNull();
    expect(await loadApprovedExclusion(store, "m1", { digest: LIST.digest, entities: LIST.entities.length, applies: true })).not.toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ the customer's words
describe("what the customer reads", () => {
  it("the reason, the zero-delivery clause and the methodology say it in Arabic, with counts only", () => {
    expect(reasonTextAr("customer_exclusion")).not.toBe("سبب آخر");
    expect(REASON_TEXT_AR.customer_exclusion).toContain("ملف الاستبعاد");
    expect(checkCustomerText(reasonTextAr("customer_exclusion")).issues).toEqual([]);
    expect(zeroDeliveryReasonAr({ found: 5, pending: 0, stop: "source_exhausted", reviewStop: null, excludedByReason: { customer_exclusion: 5 } } as any)).toContain("ملف الاستبعاد");
    expect(EXISTING_REMOVAL_REASONS).toContain("customer_exclusion");
    expect(isAllowedRemovalRaw("customer_exclusion")).toBe(true);
    const s = companyStage();
    const m = buildMethodology({ plan: planWith(s), layouts: [], rowsByStage: { companies: [{ id: "2" }, { id: "4", [EXCLUSION_POSSIBLE_MARK]: true }] }, facts: { requestText: "x", reviewStop: null, stages: { companies: { found: 5, duplicates: 0, accepted: 2, excluded: 3, pending: 0, unchecked: 0, acceptedByRule: 2, acceptedByModel: 0, excludedByReason: { customer_exclusion: 3 }, stop: "source_exhausted" } } } as any });
    const text = JSON.stringify(m);
    expect(text).toContain("طُبّق ملف الاستبعاد");
    expect(text).toContain("وارد في ملف الاستبعاد");
    expect(text).toContain("تشبه أسماؤها اسمًا في ملف الاستبعاد");
    expect(text).not.toContain("أوراسكوم");
  });
  it("no mark: the methodology has no exclusion line (flags-OFF unchanged)", () => {
    const s = companyStage();
    const m = buildMethodology({ plan: { summary_ar: "x", stages: [s], price: { deliveredRows: 5 } } as unknown as PricedPlan, layouts: [], rowsByStage: { companies: [{ id: "2" }] } });
    expect(JSON.stringify(m)).not.toContain("ملف الاستبعاد");
  });
});

const settingsClient = (value: unknown) => {
  const reads: string[] = [];
  const q: any = { select: () => q, eq: (_k: string, v: string) => { reads.push(v); return q; }, maybeSingle: async () => ({ data: value === undefined ? null : { value }, error: null }) };
  return { sb: { from: (t: string) => { expect(t).toBe("agent_settings"); return q; } }, reads };
};

describe("the chat card (CUSTOMER HONESTY: OFF never claims the file was applied)", () => {
  const file = { name: "list.xlsx", baselineRowCount: 2, normalizedEntities: [{ name: "أوراسكوم للإنشاءات", domain: "orascom.com" }, { name: "بتروجت" }] };
  it("no file: nothing is read, stored or said (today's turn exactly)", async () => {
    const c = settingsClient(true);
    expect(await exclusionForCard({ sb: c.sb, userId: REPLAY_USER })).toEqual({ plan: {}, noteAr: null });
    expect(c.reads).toEqual([]);
  });
  it("switch OFF: acknowledged, said NOT applied, nothing stored", async () => {
    const r = await exclusionForCard({ sb: settingsClient(undefined).sb, userId: REPLAY_USER, exclusionFile: file });
    expect(r.plan).toEqual({});
    expect(r.noteAr).toBe(exclusionNotAppliedAr(2));
    expect(r.noteAr).toContain("غير مفعّل");
    expect(r.noteAr).not.toMatch(/تم .*استبعاد|سيتم استبعاد|طُبّق/);
    expect(checkCustomerText(r.noteAr!).issues).toEqual([]);
  });
  it("switch ON for another account only: still OFF for this one", async () => {
    const r = await exclusionForCard({ sb: settingsClient({ user_ids: [OTHER_USER] }).sb, userId: REPLAY_USER, exclusionFile: file });
    expect(r.plan).toEqual({});
  });
  it("switch ON: the snapshot goes on the card, with an honest sentence", async () => {
    const r = await exclusionForCard({ sb: settingsClient({ user_ids: [REPLAY_USER] }).sb, userId: REPLAY_USER, exclusionFile: file });
    expect(parseExclusionSnapshot((r.plan as any).customerExclusion)!.entities).toHaveLength(2);
    expect(r.noteAr).toContain("ستوضح خطة المهمة");
    expect(checkCustomerText(r.noteAr!).issues).toEqual([]);
  });
  it("an unusable file is said, never stored", async () => {
    const r = await exclusionForCard({ sb: settingsClient(true).sb, userId: REPLAY_USER, exclusionFile: { name: "x", baselineRowCount: 0, normalizedEntities: [] } });
    expect(r).toEqual({ plan: {}, noteAr: EXCLUSION_UNUSABLE_AR });
  });
  it("a whole chat turn with the switch OFF: the card's message says NOT applied and carries no list", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("no network"); });
    const db = createMemoryDb();
    const { client } = replayClient(db, fakeMoneyClient({}));
    db.seed("agent_worker_heartbeat", [{ worker_id: "w", beat_at: new Date().toISOString() }]);
    db.seed("conversations", [{ id: "conv1", user_id: REPLAY_USER, title: "محادثة جديدة" }]);
    db.seed("messages", [{ id: "u1", conversation_id: "conv1", role: "user", user_id: REPLAY_USER }, { id: "a1", conversation_id: "conv1", role: "assistant", user_id: REPLAY_USER }]);
    const turn = await agentChatTurn({ sb: client, userId: REPLAY_USER, conversationId: "conv1", userMsgId: "u1", assistantMsgId: "a1", message: "عايز ٣ شركات كهروميكانيكا في مصر", conversationTitle: "محادثة جديدة", exclusionFile: file });
    expect(turn.ok).toBe(true);
    const card = db.rows("messages").find((m: any) => m.id === "a1")!;
    expect(card.content_ar).toContain("غير مفعّل");
    expect(card.plan.agentMissionId).toBe((turn as any).missionId);
    expect(card.plan.customerExclusion).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------ a whole mission, replayed offline
describe("a whole replayed mission: companies, their employees and work e-mails, with one company in the customer's list", () => {
  const COMPANIES = "aiark.companies.search";
  const EMPLOYEES = "aviato.companies.employees";
  const EMAILS = "blitzapi.people.email.find";
  const MAILS = ["ahmed.hassan@company1.example", "ahmed.salim@company1.example", "mona.hassan@company2.example", "mona.salim@company2.example", null, "khaled.salim@company3.example"];
  const personId = (c: number, p: number) => `co${c}-p${p}`;
  const LIST2 = snap([{ name: "شركة النيل للتركيبات الكهربائيه", domain: "www.company2.example" }, { name: "شركة غير موجودة في النتائج" }]);
  const world = (opts: { dropCopy: boolean }) => ({
    request: "عايز ٣ شركات كهروميكانيكا في مصر، وجوه كل شركة موظفين اتنين بإيميلاتهم",
    // the switch ON for this account in the worker's settings, and the card's list read as main.ts reads it (the chat-side write is proven above)
    makeStore: () => { const st = createMemoryStore(); st.settings[CUSTOMER_EXCLUSION_FLAG_KEY] = { user_ids: [REPLAY_USER] }; return st; },
    deps: (base: any) => ({ ...base, reviewCall: approvingReview as never, readMissionExclusion: async (_m: string, userId: string) => (userId === REPLAY_USER ? LIST2 : null) }),
    planning: planningFlow({
      progress: "أبحث عن مصدر الشركات ثم الموظفين ثم البريد المهني",
      searchWords: ["companies", "search"],
      sample: [{ endpoint: COMPANIES, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" }, why: "the cheaper sources return no author or link fields in their catalog description" }, { endpoint: EMPLOYEES, params: { website: "company1.example", page: 0, perPage: 2 }, why: "the cheaper sources return no author or link fields in their catalog description" }, { endpoint: EMAILS, params: { person_linkedin_url: "https://www.linkedin.com/in/co1-p1" }, why: "the cheaper sources return no author or link fields in their catalog description" }],
      sampleCode: "return inputs.call_0001.content.slice(0, 2).map(c => ({ id: c.id, text: c.name, url: c.domain, country: c.location.country }))",
      plan: (res: Results) => ({
        summary_ar: "ستحصل على ثلاث شركات كهروميكانيكا في مصر وموظفين اثنين من كل شركة مع بريد كل موظف المهني.",
        stages: [
          { key: "companies", title_ar: "الشركات", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "اسم الشركة" }, { key: "url", title_ar: "الموقع" }], sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 2), measured_by: [callIds(res)[0]] },
          { key: "employees", title_ar: "موظفو كل شركة", endpoint_id: EMPLOYEES, expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "text", title_ar: "اسم الموظف" }, { key: "title", title_ar: "المسمى الوظيفي" }, { key: "company", title_ar: "الشركة" }], sample_rows: [{ id: "co1-p1", text: "أحمد حسن", title: "مدير المشتريات", company: "الشركة المصرية للكهروميكانيكا" }], measured_by: [callIds(res)[1]] },
          { key: "emails", title_ar: "البريد المهني لكل موظف", endpoint_id: EMAILS, expected_rows: 6, parent_key: "employees", per_parent_rows: 1, deliver: true, columns: [{ key: "text", title_ar: "البريد المهني", kind: "work_email" }, { key: "person", title_ar: "الموظف" }], sample_rows: [{ id: MAILS[0], text: MAILS[0], person: "أحمد حسن" }], measured_by: [callIds(res)[2]] },
        ],
      }),
    }),
    execution: () => [
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" } } },
      { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].content.map(c => ({ id: c.id, text: c.name, url: c.domain, country: c.location.country }))", files: [execCalls(res)[0]] }) },
      { tool: "save_rows", args: (res: Results) => ({ stage_key: "companies", from_output: lastOutputId(res) }) },
      ...[1, 2, 3].map((c): FakeStep => ({ tool: "treg_call", args: { endpoint_id: EMPLOYEES, params: { website: `company${c}.example`, page: 0, perPage: 2 } } })),
      { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const page of Object.values(inputs)) for (const e of page.employees) out.push({ id: e.personID, parent_id: e.companyID, text: 'موظف ' + e.personID, title: e.positionList[0].title, company: e.companyID }); return out;", files: execCalls(res).slice(1, 4) }) },
      { tool: "save_rows", args: (res: Results) => ({ stage_key: "employees", from_output: lastOutputId(res) }) },
      ...MAILS.map((_, i): FakeStep => ({ tool: "treg_call", args: { endpoint_id: EMAILS, params: { person_linkedin_url: `https://www.linkedin.com/in/${personId(Math.floor(i / 2) + 1, (i % 2) + 1)}` } } })),
      { tool: "run_code", args: (res: Results) => ({ code: "const people = ['co1-p1','co1-p2','co2-p1','co2-p2','co3-p1','co3-p2']; const out = []; Object.keys(inputs).forEach((k, i) => { const p = inputs[k]; if (p.found && p.all_emails.length) out.push({ id: p.all_emails[0].email, parent_id: people[i], text: p.all_emails[0].email, person: people[i] }); }); return out;", files: execCalls(res).slice(4, 10) }) },
      { tool: "save_rows", args: (res: Results) => ({ stage_key: "emails", from_output: lastOutputId(res) }) },
      { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّم ما وُجد بعد تطبيق ملف الاستبعاد." } },
    ],
    answers: [
      tregResult(companiesPage(3), 0.0005267), tregResult(employeesPage("co1", 2), 0.005), tregResult(emailFound(MAILS[0]!), 0.000495),
      tregResult(companiesPage(3), 0.0005267), tregResult(employeesPage("co1", 2), 0.005), tregResult(employeesPage("co2", 2), 0.005), tregResult(employeesPage("co3", 2), 0.005),
      ...MAILS.map((mm) => (mm ? tregResult(emailFound(mm), 0.000495) : tregResult(emailNotFound(), 0))),
    ],
    // the private copy is lost between approval and execution (the fail-closed case)
    beforeApproval: async ({ store, missionId }: any) => { if (opts.dropCopy) store.files.delete(`${missionId}/${EXCLUSION_SNAPSHOT_PATH}`); },
  });

  it("the excluded company, its employees and their e-mails are never delivered; the charge is ceil(delivered × unit) of what was delivered", async () => {
    const r = await replay(world({ dropCopy: false }) as any);
    // the REAL planning pinned the list: digest on the approved plan, the private copy on file, the sentence on the customer's card, never the names
    expect(r.plannedPlan.customer_exclusion).toEqual({ digest: LIST2.digest, entities: 2, applies: true });
    expect(parseExclusionSnapshot(JSON.parse(String(await r.store.getFile(r.missionId, EXCLUSION_SNAPSHOT_PATH))))).toEqual(LIST2);
    expect(r.planView.notesAr.join(" ")).toContain("ملف الاستبعاد");
    expect(JSON.stringify(r.planView)).not.toContain("النيل للتركيبات الكهربائيه");
    // 2 companies + 4 employees + 3 e-mails: company 2 (in the list by its domain and its Arabic name) and everything under it is left out
    assertReplayInvariants(r, { expectDelivered: 9, expectStatus: "partial" });
    const companies = JSON.parse((await r.store.getFile(r.missionId, "rows/companies.json"))!);
    expect(companies.map((c: any) => c.id).sort()).toEqual(["co1", "co3"]);
    const employees = JSON.parse((await r.store.getFile(r.missionId, "rows/employees.json"))!);
    expect(employees.every((e: any) => e.parent_id !== "co2")).toBe(true);
    const emails = JSON.parse((await r.store.getFile(r.missionId, "rows/emails.json"))!);
    expect(emails.some((e: any) => /company2/.test(e.text))).toBe(false);
    expect(r.mission.charged_points).toBeLessThan(r.mission.reserved_points!);
    // the list never reached a provider: no outgoing call carries a listed name
    expect(JSON.stringify(r.call.mock.calls)).not.toContain("النيل للتركيبات الكهربائيه");
  });

  it("FAIL CLOSED: the approved list is missing from the mission's folder, so nothing runs and nothing is charged", async () => {
    const r = await replay(world({ dropCopy: true }) as any);
    expect(r.plannedPlan.customer_exclusion?.applies).toBe(true);
    expect(Number(r.mission.delivered_units ?? 0)).toBe(0);
    expect(Number(r.mission.charged_points ?? 0)).toBe(0);
    expect(r.money.balance()).toBe(r.initialBalance);
    // only the planning's three calls were made: execution called no provider
    expect(r.call.mock.calls.length).toBe(3);
    expect(r.store.events.some((e) => /ملف الاستبعاد المعتمد/.test(e.message_ar))).toBe(true);
  });
});

describe("a whole replayed mission executed by the CODE ENGINE (no model session): five companies and their decision makers, one company in the list", () => {
  it("the engine path checks every page through the same list: the listed company and its people are never delivered, and the charge follows what was delivered", async () => {
    const LIST3 = snap([{ name: "Nile Electromechanical", domain: "https://www.nile-em.com.eg" }]);
    const calls: TregCallOptions[] = [];
    const answer = (o: TregCallOptions) => {
      calls.push(o);
      if (o.endpointId === A1_COMPANIES) return tregResult(a1CompaniesPage, 0.0005);
      if (o.endpointId === A1_PEOPLE) { const slug = pickCompany(o); return tregResult(slug ? peopleOfCompany(slug) : { results: [] }, 0.0005); }
      return tregResult({ found: false }, 0);
    };
    const r = await replay({
      request: a1Request, planning: a1PlanFlow(), execution: () => [], answers: Array.from({ length: 140 }, () => answer),
      makeStore: () => { const st = createMemoryStore(); st.settings[CUSTOMER_EXCLUSION_FLAG_KEY] = { user_ids: [REPLAY_USER] }; return st; },
      deps: (base) => ({ ...base, readMissionExclusion: async () => LIST3 }),
    });
    expect(r.plannedPlan.customer_exclusion).toMatchObject({ applies: true, entities: 1 });
    // the engine ran (no model execution session)
    expect(r.executionDriver.results).toEqual([]);
    // 4 of the 5 planned companies exist outside the list: a partial delivery, charged ceil(delivered × unit), never above the reserve
    assertReplayInvariants(r, { expectStatus: "partial" });
    const rows = JSON.stringify(await Promise.all(r.plannedPlan.stages.filter((s) => s.deliver).map(async (s) => JSON.parse((await r.store.getFile(r.missionId, `rows/${s.key}.json`)) ?? "[]"))));
    expect(rows).not.toMatch(/nile-em|Nile Electromechanical/);
    expect(rows).toMatch(/Orascom Electromechanical/);
    // no people were ever asked for the excluded company
    expect(calls.filter((c) => c.endpointId === A1_PEOPLE && JSON.stringify(c.params ?? {}).includes("nile-em")).length).toBe(0);
  });
});

describe("an uploaded list meant for ENRICHMENT is never applied as an exclusion list (Phase 5.3-B is not supported yet)", () => {
  const file = { name: "list.xlsx", baselineRowCount: 2, normalizedEntities: [{ name: "أوراسكوم للإنشاءات" }, { name: "بتروجت" }] };
  it("reads the customer's intent by code", () => {
    for (const t of ["هات المواقع الرسمية للشركات اللي في الملف", "عايز ايميلات الشركات الموجودة في الملف", "كمّل بيانات القائمة المرفقة", "هات حسابات السوشيال للشركات المرفقة", "enrich the companies in the sheet", "إثراء الملف بالمواقع"]) expect(uploadIntentOf(t), t).toBe("enrichment");
    for (const t of ["عايز ٥٠ شركة مقاولات في مصر واستبعد الشركات اللي في الملف", "شركات مقاولات غير الموجودة في الملف", "هات شركات جديدة ماعدا اللي في الشيت", "companies except the ones in the file"]) expect(uploadIntentOf(t), t).toBe("exclusion");
    for (const t of ["عايز ٥٠ شركة مقاولات في مصر", "", null]) expect(uploadIntentOf(t)).toBe("unspecified");
  });
  it("switch ON or OFF: an enrichment request stores no list and says plainly that enrichment files are not supported", async () => {
    for (const value of [undefined, true, { user_ids: [REPLAY_USER] }]) {
      const r = await exclusionForCard({ sb: settingsClient(value).sb, userId: REPLAY_USER, exclusionFile: file }, "هات المواقع الرسمية للشركات اللي في الملف");
      expect(r).toEqual({ plan: {}, noteAr: ENRICHMENT_NOT_SUPPORTED_AR });
    }
    expect(checkCustomerText(ENRICHMENT_NOT_SUPPORTED_AR).issues).toEqual([]);
  });
  it("an explicit exclusion request with the switch ON still stores the list", async () => {
    const r = await exclusionForCard({ sb: settingsClient(true).sb, userId: REPLAY_USER, exclusionFile: file }, "عايز ٥٠ شركة مقاولات واستبعد اللي في الملف");
    expect((r.plan as any).customerExclusion).toBeDefined();
  });
});

describe("a whole chat turn with the switch ON and an ENRICHMENT request", () => {
  it("the card carries no list and says enrichment files are not supported", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("no network"); });
    const db = createMemoryDb();
    const { client } = replayClient(db, fakeMoneyClient({}));
    db.seed("agent_settings", [{ key: CUSTOMER_EXCLUSION_FLAG_KEY, value: true }]);
    db.seed("agent_worker_heartbeat", [{ worker_id: "w", beat_at: new Date().toISOString() }]);
    db.seed("conversations", [{ id: "conv1", user_id: REPLAY_USER, title: "محادثة جديدة" }]);
    db.seed("messages", [{ id: "u1", conversation_id: "conv1", role: "user", user_id: REPLAY_USER }, { id: "a1", conversation_id: "conv1", role: "assistant", user_id: REPLAY_USER }]);
    const file = { name: "list.xlsx", baselineRowCount: 2, normalizedEntities: [{ name: "أوراسكوم للإنشاءات" }, { name: "بتروجت" }] };
    const turn = await agentChatTurn({ sb: client, userId: REPLAY_USER, conversationId: "conv1", userMsgId: "u1", assistantMsgId: "a1", message: "عايز المواقع الرسمية وإيميلات الشركات اللي في الملف", conversationTitle: "محادثة جديدة", exclusionFile: file });
    const card = db.rows("messages").find((m: any) => m.id === "a1")!;
    expect(String(card.content_ar ?? turn.contentAr)).toContain(turn.ok ? ENRICHMENT_NOT_SUPPORTED_AR : "");
    expect(card.plan?.customerExclusion).toBeUndefined();
    // and the same turn with an exclusion request stores it (the switch is really ON here)
    db.seed("messages", [{ id: "u2", conversation_id: "conv2", role: "user", user_id: REPLAY_USER }, { id: "a2", conversation_id: "conv2", role: "assistant", user_id: REPLAY_USER }]);
    db.seed("conversations", [{ id: "conv2", user_id: REPLAY_USER, title: "محادثة جديدة" }]);
    const turn2 = await agentChatTurn({ sb: client, userId: REPLAY_USER, conversationId: "conv2", userMsgId: "u2", assistantMsgId: "a2", message: "عايز ٣ شركات كهروميكانيكا في مصر واستبعد الشركات اللي في الملف", conversationTitle: "محادثة جديدة", exclusionFile: file });
    expect(turn2.ok).toBe(true);
    expect(turn.ok).toBe(true);
    expect(db.rows("messages").find((m: any) => m.id === "a2")!.plan.customerExclusion.entities).toHaveLength(2);
  });
});
