import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ChatHandler } from "@/functions/shared/chatHandler";
import { setChatModelForTesting, type ChatModelCall } from "@/lib/agentMission/chatModel";
import { AGENT_BUCKET } from "@/lib/agentMission/constants";
import { applySpecToRows, SHAPE_CHOICE_QUESTION_ID, type DatasetColumn } from "@/lib/fileSpec";
import { readDeliveredTable } from "@/lib/agentMission/deliveredTable";
import { resolveValueTerms, validateShapedOutput, type ResultValues } from "@/lib/shapeTurn";
import { createChatDb } from "./helpers/chatSession";
import { fakeSupabase } from "./helpers/fakeSupabase";

/**
 * UL2a-2b B5 (D-0262): «فلتر النتائج على القاهرة» on the real 5-company shape (3 of 5 rows in «القاهرة»): the shaping model listed «القاهرة» and «النتائج» as missing columns and the C5 check blocked a filter that main builds.
 * A term that is a VALUE in exactly one visible column of the file's own cells is a filter on it; in two columns it is ONE question; in no column it stays a missing column (a real missing column and the value that exists
 * elsewhere still give the C5 card, never a silent swap); the product's own fields never count; a term that only refers to the delivered file («use: file») blocks nothing. Offline; no model, no key.
 */
const COLS: DatasetColumn[] = [{ key: "name", titleAr: "اسم الشركة" }, { key: "city", titleAr: "المدينة" }, { key: "loc", titleAr: "المقر والنطاق الجغرافي" }, { key: "_relevance_reason", titleAr: "حقل إضافي ٢" }];
const VALUES: ResultValues = { name: ["نايل", "دلتا", "الأهرام", "ميتا", "سيتي"], city: ["القاهرة", "الإسكندرية", "الجيزة"], loc: ["مصر الجديدة", "سموحة", "الدقي"], _relevance_reason: ["القاهرة"] };
const B5_SPEC = { filters: [{ column: "المدينة", op: "contains", value: "القاهرة" }] };
const out = (spec: unknown, named: any[], extra: Record<string, unknown> = {}) => ({ type: "shape_file", spec, named, ...extra });

describe("V1/V4: a value of the cells is a filter; a term about the file itself blocks nothing", () => {
  it("(1) the B5 answer of the real model (filter already on المدينة, «النتائج» and «القاهرة» listed as missing) → ok: one filter on المدينة, no duplicate", () => {
    const r = validateShapedOutput(out(B5_SPEC, [{ said: "النتائج", column: null, use: "file" }, { said: "القاهرة", column: null, use: "value" }]), COLS, { values: VALUES });
    expect(r?.kind).toBe("ok");
    expect((r as any).spec.filters).toEqual([{ column: "city", op: "contains", value: "القاهرة" }]);
  });
  it("the same answer WITHOUT the cells (the old behaviour) is blocked: the cells are what resolve it", () => {
    expect(validateShapedOutput(out(B5_SPEC, [{ said: "النتائج", column: null, use: "file" }, { said: "القاهرة", column: null }]), COLS)?.kind).not.toBe("ok");
  });
  it("a spec with NO filter and a value term → the filter is added: city equals القاهرة", () => {
    const r = validateShapedOutput(out({}, [{ said: "القاهرة", column: null }]), COLS, { values: VALUES });
    expect(r?.kind).toBe("ok");
    expect((r as any).spec.filters).toEqual([{ column: "city", op: "equals", value: "القاهرة" }]);
  });
  it("a term nobody labelled «file» that is neither a column nor a value stays a missing column (never dropped on a guess)", () => {
    const r = validateShapedOutput(out(B5_SPEC, [{ said: "النتائج", column: null }, { said: "القاهرة", column: null }]), COLS, { values: VALUES });
    expect(r?.kind).not.toBe("ok");
    expect((r as any).finalContentAr).toContain("«النتائج»");
  });
});

describe("(2)(3) a real missing column is still the C5 card; a missing column + a value that exists elsewhere is never a silent swap", () => {
  it("(2) «المحافظة» (no such column, no such value): the C5 line/card names it and the closest columns come first", () => {
    const r: any = validateShapedOutput(out({ groupBy: { column: "المدينة" } }, [{ said: "المحافظة", column: "المدينة" }], { closest: ["المدينة"] }), COLS, { values: VALUES });
    expect(r.kind).toBe("question");
    expect(r.finalContentAr).toContain("«المحافظة»");
    expect(r.item.options[0]).toBe("المدينة");
  });
  it("(3) «فلتر المحافظة على القاهرة»: the value resolves, the missing column still blocks → the card names «المحافظة»", () => {
    const r: any = validateShapedOutput(out(B5_SPEC, [{ said: "المحافظة", column: null, use: "column" }, { said: "القاهرة", column: null, use: "value" }], { closest: ["المدينة"] }), COLS, { values: VALUES });
    expect(r.kind).not.toBe("ok");
    expect(r.finalContentAr).toContain("«المحافظة»");
    expect(r.finalContentAr).not.toContain("«القاهرة»");
  });
});

describe("V2/V3: two columns → ONE question; internal columns never count", () => {
  it("(4) a value in 2 visible columns → the choice card, both columns, nothing picked", () => {
    const values = { ...VALUES, loc: ["القاهرة", "سموحة"] };
    const r: any = validateShapedOutput(out({}, [{ said: "القاهرة", column: null }]), COLS, { values });
    expect(r.kind).toBe("question");
    expect(r.item.id).toBe(SHAPE_CHOICE_QUESTION_ID);
    expect(r.item.options).toEqual(["فلتر الملف على المدينة يساوي القاهرة", "فلتر الملف على المقر والنطاق الجغرافي يساوي القاهرة"]);
    expect(r.finalContentAr).not.toContain("حقل إضافي");
    expect(JSON.stringify(r.item)).not.toContain("حقل إضافي");
  });
  it("(4) a value only in an INTERNAL column is not a value: the term stays missing and the internal field is never shown", () => {
    const values = { ...VALUES, city: ["الإسكندرية"], loc: ["سموحة"] };
    const r: any = validateShapedOutput(out({}, [{ said: "القاهرة", column: null }]), COLS, { values });
    expect(r.kind).not.toBe("ok");
    expect(r.finalContentAr).toContain("«القاهرة»");
    expect(JSON.stringify(r)).not.toContain("حقل إضافي");
  });
  it("resolveValueTerms leaves a term that already IS a real column alone; nothing is read when there are no values", () => {
    const r = resolveValueTerms({ named: [{ said: "المدينة", column: "المدينة" }], spec: {}, columns: COLS, values: VALUES });
    expect(r.named).toHaveLength(1);
    expect(r.ambiguous).toEqual([]);
    expect(validateShapedOutput(out({}, [{ said: "المدينة", column: "المدينة" }]), COLS)?.kind).toBe("ok");
  });
});

describe("through the real handler on a delivered agent workbook (5 companies, 3 in القاهرة)", () => {
  let bytes: Buffer;
  beforeAll(async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary");
    const ws = wb.addWorksheet("Data");
    ws.addRow(["اسم الشركة", "المدينة", "المقر والنطاق الجغرافي"]);
    for (const [n, c, l] of [["نايل", "القاهرة", "مصر الجديدة"], ["دلتا", "الإسكندرية", "سموحة"], ["الأهرام", "القاهرة", "الدقي"], ["ميتا", "الجيزة", "الهرم"], ["سيتي", "القاهرة", "التجمع"]]) ws.addRow([n, c, l]);
    bytes = Buffer.from(await wb.xlsx.writeBuffer());
  });
  afterEach(() => setChatModelForTesting(null));
  const json = (obj: unknown) => ({ ok: true as const, text: JSON.stringify(obj), usage: { inputTokens: 420, outputTokens: 60 } });

  function world(shapeAnswer: unknown) {
    const conversationId = "conv_vf", userId = "user_vf", missionId = "msn_agent_vf_12345678", jobId = "job_agent_vf_12345678";
    const tables: Record<string, any[]> = {
      conversations: [{ id: conversationId, $id: conversationId, user_id: userId, userId, title: "x", status: "active", totalTokens: 0 }],
      messages: [{ id: "msg_card", conversation_id: conversationId, user_id: userId, created_at: "2026-11-27T10:05:00Z", plan: { agentMissionId: missionId } }],
      missions: [{ id: missionId, user_id: userId, job_id: jobId, files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }], delivered_units: 5 }],
      jobs: [{ id: jobId, user_id: userId, conversation_id: conversationId, endpoint_id: "agent-mission", status: "completed", charged_credits: 10, delivered_units: 5, created_at: "2026-11-27T10:06:00Z" }],
      llm_usage: [], notes: [],
    };
    const supabase = fakeSupabase({ tables });
    const files: Record<string, Buffer> = { [`${AGENT_BUCKET}/${missionId}/result/result.xlsx`]: bytes };
    const db: any = {
      ...createChatDb(),
      from: (t: string) => { const b = supabase.from(t); b.update = () => { const u: any = { eq: () => u, then: (res: any, rej: any) => Promise.resolve({ error: null }).then(res, rej) }; return u; }; return b; },
      rpc: (fn: string, a: any) => supabase.rpc(fn, a),
      storage: { from: (bucket: string) => ({ download: async (path: string) => { const f = files[`${bucket}/${path}`]; return f ? { data: { text: async () => f.toString("utf-8"), arrayBuffer: async () => f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) }, error: null } : { data: null, error: { message: "not found", status: 404 } }; } }) },
    };
    let shapeCalls = 0;
    setChatModelForTesting((async (input: any) => { if (String(input.system).includes("You turn a customer's request about HOW")) { shapeCalls++; return json(shapeAnswer); } return json({ closest: ["المدينة", "المقر والنطاق الجغرافي"] }); }) as ChatModelCall);
    const ask = (message: string) => new ChatHandler(db).handleUserMessage({ userId, conversationId, message, userBalance: 5000 }) as Promise<any>;
    return { ask, tables, jobId, shapeCalls: () => shapeCalls };
  }
  const nothingStarted = (w: ReturnType<typeof world>, r: any) => { expect(r.agentMission).toBeUndefined(); expect(r.planQuote).toBeUndefined(); expect(w.tables.credit_ledger ?? []).toHaveLength(0); };

  it("(1) «فلتر النتائج على القاهرة» → the file is built: a filter on المدينة = القاهرة, 3 rows, 0 missions / quotes, ledger untouched", async () => {
    const w = world({ kind: "shape", spec: B5_SPEC, named: [{ said: "النتائج", column: null, use: "file" }, { said: "القاهرة", column: null, use: "value" }], closest: [] });
    const r = await w.ask("فلتر النتائج على القاهرة");
    expect(w.shapeCalls()).toBe(1);
    expect(r.fileShape, r.contentAr).toBeDefined();
    expect(r.fileShape.jobId).toBe(w.jobId);
    expect(r.fileShape.spec.filters).toHaveLength(1);
    const table: any = await readDeliveredTable(bytes);
    expect(applySpecToRows(table.rows, r.fileShape.spec)).toHaveLength(3);
    nothingStarted(w, r);
  });
  it("(1b) the model gave NO filter at all and listed «القاهرة» as missing → the filter is made from the cells", async () => {
    const w = world({ kind: "shape", spec: {}, named: [{ said: "القاهرة", column: null }], closest: [] });
    const r = await w.ask("فلتر النتائج على القاهرة");
    expect(r.fileShape, r.contentAr).toBeDefined();
    const table: any = await readDeliveredTable(bytes);
    expect(applySpecToRows(table.rows, r.fileShape.spec)).toHaveLength(3);
  });
  it("M5 / (2): «قسّم الملف حسب المحافظة ورتبه حسب اسم الشركة» (the model swaps المدينة in) → «غير موجود» naming «المحافظة», ONE card, closest first, no file", async () => {
    const w = world({ kind: "shape", spec: { groupBy: { column: "المدينة" }, sortBy: [{ column: "اسم الشركة", direction: "asc" }] }, named: [{ said: "المحافظة", column: "المدينة", use: "column" }, { said: "اسم الشركة", column: "اسم الشركة", use: "column" }], closest: ["المدينة"] });
    const r = await w.ask("قسّم الملف حسب المحافظة ورتبه حسب اسم الشركة");
    expect(r.fileShape).toBeUndefined();
    expect(r.outputType).toBe("ask_clarification");
    expect(r.contentAr).toContain("«المحافظة»");
    expect(r.contentAr).toContain("غير موجود");
    expect(r.clarificationItems).toHaveLength(1);
    expect(r.clarificationItems[0].options[0]).toBe("المدينة");
    nothingStarted(w, r);
  });
  it("(3) «فلتر النتائج على المحافظة القاهرة» (a text the shaping reader accepts) → still the C5 answer naming «المحافظة», no file (no silent column swap)", async () => {
    const w = world({ kind: "shape", spec: B5_SPEC, named: [{ said: "المحافظة", column: null, use: "column" }, { said: "القاهرة", column: null, use: "value" }], closest: ["المدينة"] });
    const r = await w.ask("فلتر النتائج على المحافظة القاهرة");
    expect(r.fileShape).toBeUndefined();
    expect(r.contentAr).toContain("«المحافظة»");
    nothingStarted(w, r);
  });
  it("(5) sort by «اسم الشركة» is read by code: built, no model call", async () => {
    const w = world({ kind: "cant" });
    const r = await w.ask("رتب الملف حسب اسم الشركة");
    expect(r.fileShape).toBeDefined();
    expect(w.shapeCalls()).toBe(0);
  });
});
