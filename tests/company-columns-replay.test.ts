import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook } from "./helpers/agentReplay";
import { cell, g1, PHONES } from "./helpers/g1World";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { executionBudgetUsd } from "../src/lib/agentMission/price";

/**
 * GOLDEN PROMPT G1 (docs/AUDIT-2026-11.md section 7), OFFLINE REPLAY, PART b: the company's own e-mail and HQ phone are COLUMNS OF THE COMPANY (reference A, columns 5 and 6, the owner's top priority).
 * The five companies of the A1 world now carry what the free companies source really gives (a phone and a street address for three of them, none for two); the world is tests/helpers/g1World.ts. BEFORE: no company e-mail column, no HQ phone column (msn_7539…, msn_4969…).
 * AFTER: the HQ phone is the source's own value (zero extra cost); a role mailbox found anywhere (the people source, then a lister) is the company e-mail, verified «موثّق» / «غير موثّق»; the phone of a company whose own data has none is looked up once on a map search;
 * what is not found is «غير متوفر». The delivered count and the charge do not move.
 */
const catalog = loadTregCatalog();

async function companySheet(r: Awaited<ReturnType<typeof g1>>) {
  const sheet = (await readWorkbook(r)).worksheets[1];
  const header = (sheet.getRow(1).values as unknown[]).map(cell);
  const rows = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2));
  const col = (title: string) => { const at = header.indexOf(title); expect(at, `column «${title}» in ${JSON.stringify(header)}`).toBeGreaterThan(0); return rows.map((row) => cell(row.getCell(at).value)); };
  return { header, rows, col };
}

describe("G1 replay, part b: the company sheet", () => {
  it("the company sheet carries the reference columns in the reference order: name, sector, website, e-mail with its status, HQ phone", async () => {
    const r = await g1();
    const { header } = await companySheet(r);
    const order = ["اسم الشركة", "النشاط والتخصص", "الموقع الإلكتروني", "الإيميل العام للشركة", "حالة توثيق الإيميل العام للشركة", "هاتف المقر الرئيسي"];
    const at = order.map((t) => header.indexOf(t));
    expect(at.every((i) => i > 0), JSON.stringify(header)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // the planner's other columns follow the reference's, the system columns stay last, and the old by-product column is gone (its addresses ARE the company e-mail now)
    expect(header).not.toContain("إيميلات عامة للشركة");
    expect(header.indexOf("المدينة")).toBeGreaterThan(at[at.length - 1]);
  });

  it("the HQ phone is the source's own value for the three companies that have one; the two that have none are looked up on a map search (the chain stops at the first answer): one is found (written in the normalized form the people's phones are), one is «غير متوفر»", async () => {
    const r = await g1();
    const s = await companySheet(r);
    expect(s.col("هاتف المقر الرئيسي")).toEqual([PHONES[0], PHONES[1], PHONES[2], "+20227770005", "غير متوفر"]);
    const maps = (await r.store.listCalls(r.missionId)).filter((c) => c.phase === "execution" && catalog.byId.get(c.endpoint_id)?.capability === "google.serp.maps");
    // the company step asks once for Cairo (found) and walks the chain for Suez (three searches, nothing); the people's step does not pay for the same search again
    expect(maps.length).toBe(4);
    expect(new Set(maps.map((c) => JSON.stringify((c.params_digest as Record<string, unknown>).q ?? (c.params_digest as Record<string, unknown>).query))).size).toBe(2);
  });

  it("the company e-mail: the people source's role mailbox (nile), then a lister's (orascom: info@ before sales@, delta), verified «موثّق» / «غير موثّق»; nothing found or another domain's: «غير متوفر»; never a person's address", async () => {
    const r = await g1();
    const s = await companySheet(r);
    expect(s.col("الإيميل العام للشركة")).toEqual(["info@orascom-em.com.eg", "info@nile-em.com.eg", "webmaster@delta-em.com.eg", "غير متوفر", "غير متوفر"]);
    expect(s.col("حالة توثيق الإيميل العام للشركة")).toEqual(["موثّق", "موثّق", "غير موثّق", "", ""]);
    // nile's mailbox came with the people source: no lister call for it; the other four companies were looked up once each
    const listerCalls = (await r.store.listCalls(r.missionId)).filter((c) => c.phase === "execution" && catalog.byId.get(c.endpoint_id)?.capability === "companies.emails.list");
    expect(listerCalls.length).toBe(4);
  });

  it("nothing moves in the money: 5 companies + 10 people delivered, the charge is ceil(delivered x unit) inside the reserve, the spend inside the job budget; no provider, endpoint id or dollar amount in the customer's view", async () => {
    const r = await g1();
    assertReplayInvariants(r, { expectDelivered: 15, expectStatus: "completed" });
    expect(Number(r.mission.charged_points)).toBeLessThanOrEqual(Number(r.mission.reserved_points));
    expect(Number(r.mission.execution_treg_usd)).toBeLessThanOrEqual(executionBudgetUsd(Number(r.mission.reserved_points)) + 1e-9);
    const view = JSON.stringify(r.planView);
    expect(view).toContain("الإيميل العام للشركة");
    expect(r.plannedPlan.contact_steps!.filter((x) => x.level === "company").map((x) => x.kind)).toEqual(["email", "phone"]);
  });
});
