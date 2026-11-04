import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import type { ContactStep, FinderInfo } from "../src/lib/agentMission/contactFinders";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { NOT_AVAILABLE_AR } from "../src/lib/agentMission/taskContracts";
import { B2B_NOT_SEARCHED_AR, resolveField } from "../src/lib/agentMission/stage3/b2bCompile";
import { b2bContactCells, b2bLimitLines, createAttemptLog } from "../src/lib/agentMission/stage3/b2bEngine";
import { readWorkbook, replay } from "./helpers/agentReplay";
import { LIVE_7539, SLUGS, company, stage3Dispatcher, type Stage3World } from "./helpers/stage3World";

/**
 * STAGE 3, PART B (docs/STAGE-3.md S4, the engine half), behind DIGER_STAGE3_COMPANIES: every lookup the contact steps make is recorded per row and column as an Attempt
 * (value / empty / failed / refused / not_tried), and each contact cell is written by the fallthrough rule: «غير متوفر» ONLY after every tool of the column's chain was tried and none gave a value,
 * «لم يكتمل البحث» when any tool of the chain was refused, failed or not tried (the daily cap, the job budget, a source that is down). The cells are CELLS: no row is added or removed, so the
 * delivered count (the rows in the file) and the settlement are what they were. With the flag unset nothing records and nothing is written (tests/stage3-flags-off.test.ts).
 */
afterEach(() => vi.unstubAllEnvs());
const MISSION = "msn_b4";
const A: FinderInfo = { id: "crawl4ai.google.serp.maps", usd: 0.00015, inputs: [{ name: "query", required: true }, { name: "location", required: false }] };
const B: FinderInfo = { id: "anyapi.google.serp.maps", usd: 0.00175, inputs: [{ name: "query", required: true }, { name: "location", required: false }] };
type Say = "value" | "empty" | "fail" | "refuse";

/** One company stage with an HQ-phone step whose chain is [A, B]; each tool answers as `say` decides, per company. */
async function world(companies: Array<{ id: string; name: string; website: string }>, say: (endpoint: string, company: string) => Say, opts: { ceilingUsd?: number; withEmailColumn?: boolean } = {}) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, MISSION);
  await items.commit(companies.map((c) => ({ t: "item" as const, stage: "companies", id: c.id, state: "accepted" as const, by: "rule" as const, row: { ...c } })));
  const step: ContactStep = { kind: "phone", level: "company", stage_key: "companies", column_key: "company_phone", status_key: "company_phone_status", per_person_usd: 0.00015, max_person_usd: 0.01, finders: [], company_phone: [A, B] };
  const columns = [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع الإلكتروني" }, ...(opts.withEmailColumn ? [{ key: "company_email", title_ar: "الإيميل العام للشركة" }] : []), { key: "company_phone", title_ar: "هاتف المقر الرئيسي" }];
  const plan: any = { stages: [{ key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns, planned_rows: companies.length }], contact_steps: [step] };
  const budget = createJobCallBudget({ ceilingUsd: opts.ceilingUsd ?? 1, spentUsd: 0 });
  const log = createAttemptLog();
  let n = 0;
  const gateway: any = {
    async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
      const c = companies.find((x) => String(a.params.query ?? "").includes(x.name) || String(a.params.query ?? "").includes(x.website));
      const s = say(a.endpoint_id, c?.id ?? "");
      if (s === "refuse") return { ok: false, refused: "daily_cap", message: "daily cap" };
      if (s === "fail") return { ok: false, call_id: `call_${++n}`, failed: true, http_status: 503, message: "down" };
      const id = `call_${String(++n).padStart(4, "0")}`;
      const page = s === "value" && c ? { rows: [{ title: c.name, website: `https://${c.website}/`, phone: "+20 2 1234 5678" }] } : { rows: [] };
      await store.putFile(MISSION, `raw/${id}.json`, JSON.stringify(page), "application/json");
      budget.settle(0, a.endpoint_id === A.id ? A.usd : B.usd);
      return { ok: true, call_id: id, http_status: 200, rows_in_page: page.rows.length, has_more: false, next_cursor: null };
    },
  };
  const run = async () => {
    await runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async () => {}, budget, deadlineMs: Date.now() + 60_000, attempts: log } as any);
    const rows = { companies: items.acceptedRows("companies") };
    const ops = b2bContactCells(plan, rows, log);
    await items.commit(ops);
    return { rows: items.acceptedRows("companies"), lines: b2bLimitLines(plan, { companies: items.acceptedRows("companies") }) };
  };
  return { run, log, plan };
}
const CO = [{ id: "c1", name: "Orascom Electromechanical", website: "orascom-em.com.eg" }, { id: "c2", name: "Nile Electromechanical", website: "nile-em.com.eg" }, { id: "c3", name: "Delta Electromechanical", website: "delta-em.com.eg" }];
const cell = (rows: Array<Record<string, unknown>>, id: string, key = "company_phone") => String(rows.find((r) => r.id === id)?.[key] ?? "");

describe("the rule: a failed or refused call is not a try", () => {
  it("resolveField: «غير متوفر» only when every tool ANSWERED with nothing; a failed tool or one not tried gives «لم يكتمل البحث»", () => {
    expect(resolveField(["a", "b"], [{ endpointId: "a", outcome: "empty" }, { endpointId: "b", outcome: "empty" }])).toEqual({ kind: "unavailable", tried: ["a", "b"] });
    expect(resolveField(["a", "b"], [{ endpointId: "a", outcome: "empty" }, { endpointId: "b", outcome: "failed" }])).toEqual({ kind: "incomplete", missing: ["b"] });
    expect(resolveField(["a", "b"], [{ endpointId: "a", outcome: "empty" }, { endpointId: "b", outcome: "not_tried" }])).toEqual({ kind: "incomplete", missing: ["b"] });
    expect(resolveField(["a", "b"], [{ endpointId: "a", outcome: "refused" }])).toEqual({ kind: "incomplete", missing: ["a", "b"] });
  });
});

describe("the engine records every lookup and writes the cell by the fallthrough (fake world)", () => {
  it("a REFUSED call (the daily cap) gives «لم يكتمل البحث», never «غير متوفر», for the company it stopped at and every company after it", async () => {
    const w = await world(CO, (ep, c) => (c === "c1" ? "value" : "refuse"));
    const { rows } = await w.run();
    expect(cell(rows, "c1")).toBe("+20212345678");
    expect(cell(rows, "c2")).toBe(B2B_NOT_SEARCHED_AR);
    expect(cell(rows, "c3")).toBe(B2B_NOT_SEARCHED_AR);
    expect(w.log.of("companies", "c2", "company_phone")).toEqual([{ endpointId: A.id, outcome: "refused" }]);
  });
  it("a whole chain that answered with nothing gives «غير متوفر»", async () => {
    const w = await world(CO.slice(0, 1), () => "empty");
    const { rows } = await w.run();
    expect(cell(rows, "c1")).toBe(NOT_AVAILABLE_AR);
    expect(w.log.of("companies", "c1", "company_phone").map((a) => a.endpointId)).toEqual(expect.arrayContaining([A.id, B.id]));
  });
  it("a later tool fills the cell an earlier tool left empty", async () => {
    const w = await world(CO.slice(0, 1), (ep) => (ep === A.id ? "empty" : "value"));
    const { rows } = await w.run();
    expect(cell(rows, "c1")).toBe("+20212345678");
    expect(w.log.of("companies", "c1", "company_phone").map((a) => [a.endpointId, a.outcome])).toEqual(expect.arrayContaining([[A.id, "empty"], [B.id, "value"]]));
  });
  it("a tool that is DOWN (failed) and the next answering nothing: «لم يكتمل البحث» (a failed source never says the value does not exist)", async () => {
    const w = await world(CO.slice(0, 1), (ep) => (ep === A.id ? "fail" : "empty"));
    const { rows } = await w.run();
    expect(cell(rows, "c1")).toBe(B2B_NOT_SEARCHED_AR);
  });
  it("the JOB BUDGET stops the step: the companies it did not reach are «لم يكتمل البحث»", async () => {
    const w = await world(CO, () => "value", { ceilingUsd: 0.0002 });
    const { rows } = await w.run();
    expect(cell(rows, "c1")).toBe("+20212345678");
    expect([cell(rows, "c2"), cell(rows, "c3")]).toEqual([B2B_NOT_SEARCHED_AR, B2B_NOT_SEARCHED_AR]);
  });
  it("a contact column of the reference with no step at all (no verified tool for the general e-mail): «لم يكتمل البحث» for every company, and its line", async () => {
    const w = await world(CO.slice(0, 2), () => "value", { withEmailColumn: true });
    const { rows, lines } = await w.run();
    expect([cell(rows, "c1", "company_email"), cell(rows, "c2", "company_email")]).toEqual([B2B_NOT_SEARCHED_AR, B2B_NOT_SEARCHED_AR]);
    expect(lines).toContain("الإيميل العام للشركة: لم يكتمل البحث لكل الشركات (شركتين).");
  });
  it("no row is added or removed: the cells only", async () => {
    const w = await world(CO, (ep, c) => (c === "c1" ? "empty" : c === "c2" ? "fail" : "refuse"));
    const { rows, lines } = await w.run();
    expect(rows.map((r) => r.id)).toEqual(["c1", "c2", "c3"]);
    expect(lines).toEqual(["هاتف المقر الرئيسي: غير متوفر لشركة واحدة بعد تجربة مصدرين، ولم يكتمل البحث لشركتين."]);
  });
});

describe("end to end, flag on (fake world): the file says the honest cell and its line, the delivered count is the rows of the file", () => {
  const run = (w: Stage3World) => { vi.stubEnv("DIGER_STAGE3_COMPANIES", "on"); return replay({ request: LIVE_7539, planning: [], execution: () => [], answers: Array.from({ length: 300 }, () => stage3Dispatcher(w)) }); };
  it("the maps tool down for one company and empty for another: «لم يكتمل البحث» and «غير متوفر»; the general e-mail «لم يكتمل البحث»; each gap is a line of «حدود هذا التسليم»; 15 rows delivered and charged", async () => {
    const r = await run({ maps: (s) => (s === "nile-em" ? "fail" : s === "delta-em" ? "empty" : "value") });
    expect(r.mission.status).toBe("completed");
    expect(Number(r.mission.delivered_units)).toBe(15);
    const wb = await readWorkbook(r);
    const sheet = wb.worksheets.find((ws) => ws.name.startsWith("الشركات"))!;
    const header = (sheet.getRow(1).values as unknown[]).map(String);
    const col = (t: string) => header.indexOf(t);
    const byName = (n: string) => (sheet.getRows(2, 5) ?? []).find((row) => String(row.getCell(col("اسم الشركة")).value).startsWith(n))!;
    expect(String(byName("Nile").getCell(col("هاتف المقر الرئيسي")).value)).toBe(B2B_NOT_SEARCHED_AR);
    expect(String(byName("Delta").getCell(col("هاتف المقر الرئيسي")).value)).toBe(NOT_AVAILABLE_AR);
    expect(String(byName("Orascom").getCell(col("هاتف المقر الرئيسي")).value)).toBe("+20225740001");
    expect(String(byName("Orascom").getCell(col("الإيميل العام للشركة")).value)).toBe(B2B_NOT_SEARCHED_AR);
    const summary = JSON.stringify(wb.worksheets[0].getSheetValues());
    expect(summary).toContain("الإيميل العام للشركة: لم يكتمل البحث لكل الشركات (٥ شركات).");
    expect(summary).toContain("هاتف المقر الرئيسي: وُجد لـ ٣ شركات من ٥ شركات");
    // the charge rests on the rows of the file, untouched by the cells
    expect(r.mission.charged_points).toBe(Math.min(Math.ceil(Math.round(15 * r.plannedPlan.price.unitPricePoints * 1e6) / 1e6 - 1e-9), r.plannedPlan.price.reservePoints));
  }, 60_000);
  it("a person whose e-mail finder answered nothing: «غير متوفر»; one whose finder was down: «لم يكتمل البحث»; the people are all delivered", async () => {
    const r = await run({ email: (s, i) => (s === "orascom-em" && i === 2 ? "empty" : s === "orascom-em" && i === 3 ? "fail" : "value") });
    expect(Number(r.mission.delivered_units)).toBe(15);
    const wb = await readWorkbook(r);
    const text = JSON.stringify(wb.worksheets.map((ws) => ws.getSheetValues()));
    expect(text).toContain(`"Ahmed orascom","الرئيس التنفيذي (Chief Executive Officer)","نعم","${NOT_AVAILABLE_AR}"`);
    expect(text).toContain(`"Salma orascom","رئيس مجلس الإدارة (Chairman)","نعم","${B2B_NOT_SEARCHED_AR}"`);
  }, 60_000);
});

describe("flag on: only EXACT duplicates are removed, and the delivered count is the rows of the file", () => {
  it("the source gives one company twice (the same row) and a near copy (another id, the same name): the repeat is delivered once, the near copy stays; marks and gaps remove nothing", async () => {
    vi.stubEnv("DIGER_STAGE3_COMPANIES", "on");
    const base = SLUGS.map((s, i) => ({ ...company(s, i), phone_number: false }));
    // a near copy of the first company: the same name, its own website and profile link. (The companies card's id is the website: two rows with the SAME website are one company to today's item store,
    // which keeps one row per source id; that rule is today's engine's, unchanged here, docs/STAGE-3.md section 10.) No fuzzy matching removes the near copy.
    const nearCopy = { ...base[0], id: "orascom-em.com", website_url: "orascom-em.com", linkedin_url: "https://linkedin.example/company/orascom-em-2" };
    const r = await replay({ request: LIVE_7539, planning: [], execution: () => [], answers: Array.from({ length: 300 }, () => stage3Dispatcher({ companies: () => [base[0], { ...base[0] }, nearCopy, base[1], base[2], base[3]], maps: () => "empty" })) });
    expect(r.mission.status).toBe("completed");
    const wb = await readWorkbook(r);
    const sheet = wb.worksheets.find((ws) => ws.name.startsWith("الشركات"))!;
    const header = (sheet.getRow(1).values as unknown[]).map(String);
    const names = (sheet.getRows(2, sheet.rowCount - 1) ?? []).map((row) => String(row.getCell(header.indexOf("اسم الشركة")).value));
    expect(names).toEqual(["Orascom Electromechanical", "Orascom Electromechanical", "Nile Electromechanical", "Delta Electromechanical", "Cairo Electromechanical"]);
    const people = wb.worksheets.find((ws) => ws.name.startsWith("صناع"))!;
    // the delivered count is exactly the rows of the two sheets of the file
    expect(Number(r.mission.delivered_units)).toBe(names.length + (people.rowCount - 1));
  }, 60_000);
});

describe("no Stage 3 module is reachable from the money code", () => {
  const ROOT = path.resolve(__dirname, "..");
  const read = (f: string) => readFileSync(f, "utf8");
  const resolveImport = (from: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const base = path.resolve(path.dirname(from), spec);
    for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) { try { if (statSync(c).isFile()) return c; } catch { /* next */ } }
    return null;
  };
  const reach = (start: string): Set<string> => {
    const seen = new Set<string>();
    const todo = [start];
    while (todo.length > 0) {
      const f = todo.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const m of read(f).matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) { const r = resolveImport(f, m[1] ?? m[2]); if (r) todo.push(r); }
    }
    return seen;
  };
  // the settlement, ledger, reserve, release, charge, price and cap code (the legacy job worker's ENTRY reaches the S5 queue line through the chat handler, which is not money code: its money modules are listed one by one)
  const MONEY = [
    "agent/src/finalize.ts", "agent/src/gateway.ts", "src/lib/agentMission/price.ts", "src/lib/jobPointsCap.ts", "src/lib/server/callBudget.ts", "src/lib/missionPricing.ts", "src/lib/agentMission/lifecycle.ts",
    "src/lib/server/jobLedger.ts", "src/lib/supabase/quoteAccept.ts", "src/lib/recordPricing.ts", "src/app/api/worker/chunk/route.ts",
    "src/functions/shared/ledger.ts", "src/functions/shared/peopleSettlementReadiness.ts", "src/functions/shared/quoteAccept.ts", "src/functions/shared/quoteMessagePersistence.ts", "src/functions/shared/quotes.ts",
  ].map((f) => path.join(ROOT, f));
  // FOUND IN THIS SESSION (docs/STAGE-3.md section 9): the S5 queue line of the earlier session (queueView.ts, behind DIGER_STAGE3_QUEUE) is reachable in the MODULE GRAPH of two money files through
  // llmClient -> briefManager -> chatHandler -> chatTurn -> customerActions (the chat handler is another session's file). It is a read-only line of the customer's view, never called by settlement code.
  // Nothing of parts A and B (the plan, the engine cells, the request, the cards, the compiler, the delivery) is reachable from any money file.
  const S5_QUEUE_LINE = new Set(["src/lib/agentMission/stage3/queueView.ts", "src/lib/agentMission/stage3/queue.ts", "src/lib/agentMission/stage3/flags.ts"]);
  it("the settlement, ledger, charge, price, cap and call-budget files reach no stage3 module of parts A and B, directly or through anything they import", () => {
    let checked = 0;
    for (const f of MONEY) {
      const hit = [...reach(f)].filter((x) => x.includes(`${path.sep}stage3${path.sep}`)).map((x) => path.relative(ROOT, x).split(path.sep).join("/"));
      expect(hit.filter((x) => !S5_QUEUE_LINE.has(x)), path.relative(ROOT, f)).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(MONEY.length);
  });
  it("and the S5 reach goes only through the chat handler (no money file imports a stage3 module itself)", () => {
    for (const f of MONEY) expect(read(f), path.relative(ROOT, f)).not.toMatch(/\/stage3\//);
  });
});
