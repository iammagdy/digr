import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { dispatcher, planFlow, SECTOR_WORLD } from "./helpers/g1World";
import { tregResult } from "./helpers/agentHarness";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { settlementCharge } from "../src/lib/agentMission/price";
import { unbilledLineAr } from "../src/lib/agentMission/billableRows";
import type { FakeStep } from "../agent/src/fakeDriver";
import type { TregCallOptions } from "../src/functions/shared/tregClient";

beforeEach(() => vi.stubEnv("JOB_MAX_POINTS_CAP", ""));
afterEach(() => vi.unstubAllEnvs());

/**
 * DT-20261119-06 PART B, end to end on the money fake (owner decision D-0117): a mission of 5 companies and 10 people whose finders find a contact for only SOME people delivers the whole file (15 rows) and is charged for the rows
 * that carry a requested contact (the companies and the people with one); the hold is unchanged and the rest is released; the customer is told how many people were not charged. A request that asks for no contact is charged as before.
 */
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-19T10:00:00Z"), shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });
const catalog = loadTregCatalog();
const SLUG_OF = (params: unknown): { slug: string; j: number } | null => { const m = /in\/([a-z]+-em)-(\d)/.exec(JSON.stringify(params ?? {})); return m ? { slug: m[1], j: Number(m[2]) } : null; };
/** the g1 world whose finders answer ONLY for the people `has` says (`first`: the first person of that company the finders are asked about; the decision makers come first): an e-mail for the first person of three companies, a phone for the first person of two others (5 of the 10 people carry a contact) */
const answersWith = (has: { email: (slug: string, first: boolean) => boolean; phone: (slug: string, first: boolean) => boolean }) => {
  const firstOf = new Map<string, number>();
  let seq = 0;
  return Array.from({ length: 300 }, () => {
    const base = dispatcher({});
    return (o: TregCallOptions) => {
      const capability = catalog.byId.get(o.endpointId)?.capability ?? "";
      const who = SLUG_OF(o.params);
      if (who && !firstOf.has(who.slug) && /^people\.(email|phone)\.find$/.test(capability)) firstOf.set(who.slug, who.j);
      const first = who !== null && firstOf.get(who.slug) === who.j;
      if (capability === "people.email.find" && who && has.email(who.slug, first)) return tregResult({ email: `person${who.j}.${who.slug}@${who.slug}.com.eg` }, 0);
      if (capability === "people.phone.find" && who && has.phone(who.slug, first)) return tregResult({ phone: `+20 100 ${String(2000 + (seq += 1))}` }, 0);
      return base(o);
    };
  });
};
const FIVE = answersWith({ email: (s, first) => first && ["orascom-em", "nile-em", "delta-em"].includes(s), phone: (s, first) => first && ["cairo-em", "suez-em"].includes(s) });
const NONE = answersWith({ email: () => false, phone: () => false });
const ALL = answersWith({ email: () => true, phone: () => true });
const run = (answers: unknown[], request = SECTOR_WORLD.electromechanical.request, planning: FakeStep[] = planFlow("electromechanical")) => replay({ request, planning, execution: () => [], answers: answers as any });
const peopleSheetRows = async (r: ReplayResult): Promise<number> => { const wb = await readWorkbook(r); const sheet = wb.worksheets.find((s) => /موظف|المسؤول|صناع/.test(s.name)) ?? wb.worksheets[1]; return sheet.rowCount - 1; };
const units = (r: ReplayResult) => (r.mission.unit_price_points as number);
const chargeFor = (r: ReplayResult, rows: number) => settlementCharge({ deliveredUnits: rows, unitPricePoints: units(r), reservedPoints: r.mission.reserved_points as number }).chargedPoints;

describe("D-0117 end to end: the whole file is delivered, only the rows with a requested contact are charged", () => {
  it("5 companies + 10 people, 5 people carry a contact: delivered 15, charged for 10 rows, the hold unchanged and the rest released; the file still holds all 10 people; the customer is told 5 were not charged", async () => {
    const r = await run(FIVE);
    const m: any = r.mission;
    expect(m.status).toBe("completed");
    expect(m.delivered_units).toBe(15);
    expect(m.charged_points).toBe(chargeFor(r, 10));
    expect(m.charged_points).toBeLessThan(chargeFor(r, 15));
    // the job stored the billable count; the hold is the plan's, untouched; the release is the hold less the charge
    const chunk = [...r.money.calls].reverse().find((c) => c.name === "complete_chunk")!;
    expect((chunk.args as any).p_new_delivered_units).toBe(10);
    expect(m.reserved_points).toBe((r.plannedPlan as any).price.reservePoints);
    expect(r.money.ledger.find((l) => l.type === "charge")!.delta).toBe(-m.charged_points);
    expect(r.money.ledger.find((l) => l.type === "release")!.delta).toBe(m.reserved_points);
    expect(r.money.balance()).toBe(r.initialBalance - m.charged_points);
    // nothing was removed from the file
    expect(await peopleSheetRows(r)).toBe(10);
    // the customer's line (n = delivered - billable = 5) is a result event, before the summary
    const results = r.store.events.filter((e) => e.kind === "result").map((e) => e.message_ar);
    const at = results.indexOf(unbilledLineAr(5, ["email", "phone"]));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(results.length - 1);
    expect(r.store.events.some((e) => e.kind === "call" && e.counts?.adm_unbilled === 5)).toBe(true);
    // the admin-only note (never shown to the customer) names the reduction; no settlement problem is recorded
    expect(String(m.error ?? "")).toContain("people_without_contact_unbilled");
    expect(String(m.error ?? "")).not.toMatch(/settlement|differs/);
  }, 120_000);

  it("COUNTER: every person has a contact -> charged for all 15 rows, as before; no line about people not charged", async () => {
    const r = await run(ALL);
    const m: any = r.mission;
    expect(m.delivered_units).toBe(15);
    expect(m.charged_points).toBe(chargeFor(r, 15));
    expect(r.store.events.some((e) => e.kind === "result" && /لم يُحتسب عليك/.test(e.message_ar))).toBe(false);
  }, 120_000);

  it("no person carries a contact: the 5 companies are charged, the 10 people are delivered and not charged", async () => {
    const r = await run(NONE);
    const m: any = r.mission;
    expect(m.delivered_units).toBe(15);
    expect(m.charged_points).toBe(chargeFor(r, 5));
    expect(await peopleSheetRows(r)).toBe(10);
    expect(r.store.events.some((e) => e.kind === "result" && e.message_ar === unbilledLineAr(10, ["email", "phone"]))).toBe(true);
  }, 120_000);

  it("COUNTER: a request that asks for NO contact (no marked column, no contact words) -> every named person is charged as today, whatever the finders found", async () => {
    const noContactColumns = planFlow("electromechanical").map((s): FakeStep => {
      if (s.tool !== "propose_plan") return s;
      const make = s.args as (res: unknown) => any;
      return { ...s, args: (res: unknown) => { const a = make(res); return { ...a, stages: a.stages.map((st: any) => (st.parent_key ? { ...st, columns: st.columns.filter((c: any) => c.kind === undefined) } : st)) }; } } as FakeStep;
    });
    const r = await run(NONE, "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم أسماء المديرين ومسمياتهم", noContactColumns);
    const m: any = r.mission;
    expect(m.delivered_units).toBe(15);
    expect(m.charged_points).toBe(chargeFor(r, 15));
    expect(r.store.events.some((e) => e.kind === "result" && /لم يُحتسب عليك/.test(e.message_ar))).toBe(false);
  }, 120_000);
});

describe("the settlement call sites (a pin like the repo's own inventory tests)", () => {
  it("the one-unit call passes the BILLABLE count, the release reason of a delivered file with nothing billable is the honest sentence, the ownership check stays the line before the call, and the new numbers are computed above it", () => {
    const run = readFileSync(new URL("../agent/src/runMission.ts", import.meta.url), "utf8");
    const worker = readFileSync(new URL("../agent/src/missionSettlement.ts", import.meta.url), "utf8");
    const sql = readFileSync(new URL("../supabase/migrations/20261122010000_finalize_agent_delivery_atomic.sql", import.meta.url), "utf8");
    expect(worker).toMatch(/billable_units: billed.deliveredUnits, stage_units: billed.counts/);
    expect(worker).toMatch(/physical > 0 && billed.deliveredUnits === 0 \? noBillableReasonAr\(unbilled.kinds\)/);
    expect(worker).toMatch(/p_delivery: delivery/);
    expect(worker).toMatch(/await ensureOwned\(deps, mission.id\);\s*const result = await bounded\(\(\) => deps.client.rpc\("finalize_agent_delivery_atomic"/);
    expect(worker.indexOf("const billed = billedUnits({")).toBeGreaterThan(worker.indexOf("await readDeliveredWorkbook("));
    expect(sql).toContain("v_billed := (p_delivery ->> 'billable_units')::integer;");
    expect(sql).toContain("public.complete_chunk(v_job_id,0,'completed',v_billed,");
    expect(sql).toContain("IF v_billed > 0 THEN\n    v_disposition := 'settled';");
    // Physical delivery remains visible to the customer even when the SQL records a lower billable count.
    expect(run).toMatch(/const delivered = receipt.physical_units/);
    expect(run).toMatch(/delivered_units: delivered, /);
    expect(run).toMatch(/await tell\(deps, mission, jobId, noticeKind, \{ delivered,/);
  });
});
