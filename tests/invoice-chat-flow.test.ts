import { describe, expect, it } from "vitest";
import { applyActions, draftSummary, type ApplyCtx } from "../src/lib/invoices/chat/apply";
import { countByMapping } from "../src/lib/invoices/chat/count";
import {
  answerChip, answerText, buildFlowActions, effective, moveContact, newFlow, nextQuestion, parseMoneyAnswer, prefillFromActions, summaryText, totalsOf, type FlowCtx, type FlowState,
} from "../src/lib/invoices/chat/flow";
import { completeMappings } from "../src/lib/invoices/chat/sheets";
import type { ParsedSheetFile, SectorCount } from "../src/lib/invoices/chat/types";
import { formToInput, newDocForm, type DocForm } from "../src/lib/invoices/form";
import { DEPARTMENT_NAME, countText, otherLines, quickFields, setCount, zeroPriceNames, type ItemTypeLite } from "../src/lib/invoices/sectors";
import { newRowBudget, parseAgentFile } from "../src/lib/server/invoices/chat/parseFiles";
import { ELECTRO_MAPPING, PETRO_FILE, PETRO_MAPPING, PETRO_SHEETS, electroShapeFiles, petroShapeFile } from "./helpers/ownerShapeFixtures";

const T = (n: number, nameAr: string, unitCc: number): ItemTypeLite => ({ id: `00000000-0000-4000-8000-00000000000${n}`, nameAr, unitCc });
const TYPES = [T(1, "شركة", 1200), T(2, "مدير", 3500), T(3, "بريد إلكتروني", 45), T(4, "رقم هاتف", 500)];
const CTX: ApplyCtx = { types: TYPES, creditValueE4: 1000, canChangeDocType: true };
const load = async (f: { name: string; bytes: Uint8Array }): Promise<ParsedSheetFile> => { const p = await parseAgentFile(f.name, f.bytes, newRowBudget()); if (p.kind !== "sheet") throw new Error("x"); return p; };

/** the owner's two sectors, counted by the real code from the synthetic files of his shapes */
async function ownerSectors(): Promise<{ sectors: SectorCount[]; duplicates: number }> {
  const e = await Promise.all((await electroShapeFiles()).map(load));
  const p = await load(await petroShapeFile());
  const maps = [...e.map((f) => ({ file: f.name, sheet: "Sheet1", sectorName: "كهروميكانيكا", columns: { ...ELECTRO_MAPPING } })), ...Object.values(PETRO_SHEETS).map((s) => ({ file: PETRO_FILE, sheet: s, sectorName: "بترول", columns: { ...PETRO_MAPPING } }))];
  const c = completeMappings([...e, p], maps);
  const r = countByMapping([...e, p], c.mappings, c.inferred);
  return { sectors: r.sectors, duplicates: r.duplicateCompanies };
}
const ctxOf = (sectors: SectorCount[], over: Partial<FlowCtx> = {}): FlowCtx => ({ sectors, docType: "invoice", rateE4: 565000, showUsd: false, showPoints: false, showEgp: true, clientName: "", managerUnitUsdText: "0.35", ...over });

describe("the owner's summary sentence", () => {
  it("«لقيت: كهروميكانيكا ٢٠٠ شركة و٦٠١ مدير، بترول ١٤٩ شركة و٢٣٩ مدير و٣٢ جهة إدارية. تم تجاهل ١٥١ تكرار.»", async () => {
    const { sectors, duplicates } = await ownerSectors();
    expect(summaryText({ sectors }, [], duplicates)).toBe("لقيت: كهروميكانيكا ٢٠٠ شركة و٦٠١ مدير، بترول ١٤٩ شركة و٢٣٩ مدير و٣٢ جهة إدارية. تم تجاهل ١٥١ تكرار.");
  });
});

describe("the questions: one at a time, in order, nothing asked twice", () => {
  it("bill -> departments -> price -> (rate) -> client, then nothing; each answer is a chip or a typed amount", async () => {
    const { sectors } = await ownerSectors();
    const ctx = ctxOf(sectors);
    let s: FlowState = newFlow();
    const ids: string[] = [];
    const q1 = nextQuestion(s, ctx)!; ids.push(q1.id);
    expect(q1.text).toBe("هتحاسب على إيه؟");
    expect(q1.chips.map((c) => c.label)).toEqual(["الشركات", "المديرين", "الشركات والمديرين"]);
    s = answerChip(s, "bill", "both");
    const q2 = nextQuestion(s, ctx)!; ids.push(q2.id);
    expect(q2.text).toContain("٣٢ جهة إدارية");
    expect(q2.chips.map((c) => c.value)).toEqual(["zero", "manager", "none"]);
    s = answerChip(s, "dept", "zero");
    const q3 = nextQuestion(s, ctx)!; ids.push(q3.id);
    expect(q3.text).toBe("عايز الإجمالي يبقى كام؟ ولا أستخدم أسعارك العادية؟");
    expect(q3.chips).toEqual([{ label: "أسعاري العادية", value: "default" }]);
    expect(q3.input?.kind).toBe("money");
    const typed = answerText(s, "price", "٢٠٠٠ جنيه");
    expect(typed.ok && typed.state.target).toEqual({ currency: "egp", text: "2000" });
    s = typed.ok ? typed.state : s;
    // EGP with a saved rate: the rate is not asked; the client is
    const q4 = nextQuestion(s, ctx)!; ids.push(q4.id);
    expect(q4.id).toBe("client");
    s = answerChip(s, "client", "none");
    expect(nextQuestion(s, ctx)).toBeNull();
    expect(ids).toEqual(["bill", "dept", "price", "client"]);
  });

  it("a single kind of item skips «هتحاسب على إيه»; no departments skips their question; a client already named is not asked", () => {
    const only: SectorCount[] = [{ sector: "س", companies: 10, managers: 0, departments: 0, emails: 0, phones: 0, duplicateCompanies: 0, duplicateContacts: 0, invalidEmails: 0, ignoredPhones: 0, contacts: [] }];
    expect(nextQuestion(newFlow(), ctxOf(only))?.id).toBe("price");
    expect(nextQuestion({ ...newFlow(), price: "default" }, ctxOf(only, { clientName: "شركة النور" }))).toBeNull();
  });

  it("the exchange rate: asked when none is known (EGP needs it); with a saved rate it is asked only when DOLLARS are involved, with the saved one as a single tap; never for a statement", () => {
    const sectors: SectorCount[] = [{ sector: "س", companies: 10, managers: 0, departments: 0, emails: 0, phones: 0, duplicateCompanies: 0, duplicateContacts: 0, invalidEmails: 0, ignoredPhones: 0, contacts: [] }];
    const base = { ...newFlow(), price: "default" as const };
    const noRate = nextQuestion(base, ctxOf(sectors, { rateE4: null, clientName: "x" }))!;
    expect(noRate.id).toBe("rate");
    expect(noRate.chips).toEqual([]);
    expect(noRate.input?.kind).toBe("rate");
    expect(nextQuestion(base, ctxOf(sectors, { rateE4: 565000, clientName: "x" }))).toBeNull();                     // EGP + saved rate: nothing to ask
    const usd = nextQuestion(base, ctxOf(sectors, { rateE4: 565000, showUsd: true, clientName: "x" }))!;            // dollars shown: asked, one tap
    expect(usd.id).toBe("rate");
    expect(usd.chips).toEqual([{ label: "استخدم ٥٦.٥٠", value: "saved" }]);
    const target = { ...base, price: "target" as const, target: { currency: "usd" as const, text: "17" } };
    expect(nextQuestion(target, ctxOf(sectors, { clientName: "x" }))?.id).toBe("rate");
    expect(nextQuestion({ ...base, rate: { kind: "saved" } }, ctxOf(sectors, { showUsd: true, clientName: "x" }))).toBeNull();
    expect(nextQuestion({ ...newFlow(), client: "none" }, ctxOf(sectors, { docType: "statement" }))).toBeNull();     // no prices, no rate, no client question again
  });

  it("an amount without a currency asks which one; a chip answers it", () => {
    let s = answerText({ ...newFlow(), bill: "both", dept: "none" }, "price", "٥٠٠٠");
    expect(s.ok && s.state.pendingAmount).toBe("5000");
    const state = s.ok ? s.state : newFlow();
    const q = nextQuestion(state, ctxOf([{ sector: "س", companies: 1, managers: 1, departments: 0, emails: 0, phones: 0, duplicateCompanies: 0, duplicateContacts: 0, invalidEmails: 0, ignoredPhones: 0, contacts: [] }]))!;
    expect(q.id).toBe("currency");
    expect(q.text).toBe("٥٠٠٠ إيه؟");
    expect(q.chips.map((c) => c.value)).toEqual(["egp", "points", "usd"]);
    const after = answerChip(state, "currency", "points");
    expect(after.target).toEqual({ currency: "points", text: "5000" });
    expect(after.pendingAmount).toBeNull();
  });
});

describe("the owner's words, in code: «٢٠٠٠ جنيه», points, dollars; nothing else is an amount", () => {
  const ok = (t: string) => parseMoneyAnswer(t);
  it("EGP, points and USD in the ways he writes them", () => {
    expect(ok("٢٠٠٠ جنيه")).toEqual({ kind: "ok", currency: "egp", amountText: "2000" });
    expect(ok("2,000 ج.م")).toEqual({ kind: "ok", currency: "egp", amountText: "2000" });
    expect(ok("جنيه ٢٠٠٠")).toEqual({ kind: "ok", currency: "egp", amountText: "2000" });
    expect(ok("١٬٥٠٠ جنيه")).toEqual({ kind: "ok", currency: "egp", amountText: "1500" });
    expect(ok("٢٥٠٫٥ جنيه")).toEqual({ kind: "ok", currency: "egp", amountText: "250.5" });
    expect(ok("٥٠٠ نقطة")).toEqual({ kind: "ok", currency: "points", amountText: "500" });
    expect(ok("٥٠٠٠ نقاط")).toEqual({ kind: "ok", currency: "points", amountText: "5000" });
    expect(ok("١٧ دولار")).toEqual({ kind: "ok", currency: "usd", amountText: "17" });
    expect(ok("$17.5")).toEqual({ kind: "ok", currency: "usd", amountText: "17.5" });
    expect(ok("حوالي ٢٠٠٠ جنيه")).toEqual({ kind: "ok", currency: "egp", amountText: "2000" });
  });
  it("a bare number asks for its currency; words, zero, fractions of a point and three decimals are refused", () => {
    expect(ok("٢٠٠٠")).toEqual({ kind: "needs_currency", amountText: "2000" });
    for (const bad of ["", "كام", "ابعتلي ٣ ملفات جنيه", "٠ جنيه", "٥٠٫٥ نقطة", "١٧٫٥٥٥ دولار", "عشرين جنيه"]) expect(ok(bad).kind, bad).toBe("bad");
    const e = answerText(newFlow(), "price", "كام");
    expect(e.ok).toBe(false);
    expect(!e.ok && e.error).toContain("جنيه أو نقاط أو دولار");
    expect(answerText(newFlow(), "rate", "abc").ok).toBe(false);
    expect(answerText(newFlow(), "rate", "5000").ok).toBe(false);
    const r = answerText(newFlow(), "rate", "٥٦٫٥");
    expect(r.ok && r.state.rate).toEqual({ kind: "typed", rateE4: 565000 });
    expect(answerText(newFlow(), "client", "   ").ok).toBe(false);
  });
});

describe("people and departments: the owner can move rows between the two lists", () => {
  it("moving a department to the people list (and back) changes the counts by one, and only for that contact", async () => {
    const { sectors } = await ownerSectors();
    const petro = sectors.find((s) => s.sector === "بترول")!;
    expect(effective(petro, [])).toMatchObject({ companies: 149, managers: 239, departments: 32 });
    const dept = petro.contacts.find((c) => c.kind === "department")!;
    const person = petro.contacts.find((c) => c.kind === "person")!;
    let s = moveContact(newFlow(), dept.id);
    expect(effective(petro, s.moved)).toMatchObject({ managers: 240, departments: 31 });
    s = moveContact(s, person.id);
    expect(effective(petro, s.moved)).toMatchObject({ managers: 239, departments: 32 });
    s = moveContact(moveContact(s, dept.id), person.id);
    expect(effective(petro, s.moved)).toMatchObject({ managers: 239, departments: 32 });
    expect(totalsOf({ sectors }, [dept.id])).toEqual({ companies: 349, managers: 601 + 240, departments: 31 });
  });
});

describe("what the conversation builds: the same validated actions, no e-mails or phones as items", () => {
  const rows = (people: number, depts: number) => [...Array.from({ length: people }, (_, i) => ({ id: `p${i}`, name: `x${i}`, company: "c", kind: "person" as const })), ...Array.from({ length: depts }, (_, i) => ({ id: `d${i}`, name: `إدارة ${i}`, company: "c", kind: "department" as const }))];
  const sec = (): SectorCount[] => [
    { sector: "كهروميكانيكا", companies: 200, managers: 601, departments: 0, emails: 601, phones: 140, duplicateCompanies: 0, duplicateContacts: 0, invalidEmails: 0, ignoredPhones: 0, contacts: rows(601, 0) },
    { sector: "بترول", companies: 149, managers: 239, departments: 32, emails: 300, phones: 200, duplicateCompanies: 151, duplicateContacts: 0, invalidEmails: 0, ignoredPhones: 0, contacts: rows(239, 32) },
  ];
  it("both: companies, managers (people) and departments at price 0; e-mails and phones are not billed", () => {
    const s: FlowState = { ...newFlow(), bill: "both", dept: "zero", price: "default", rate: { kind: "saved" }, client: "none" };
    const a = buildFlowActions(s, ctxOf(sec()));
    expect(a).toEqual([
      { type: "set_counts", sector: "كهروميكانيكا", counts: { company: 200, manager: 601 } },
      { type: "set_counts", sector: "بترول", counts: { company: 149, manager: 239, department: 32 } },
    ]);
    expect(JSON.stringify(a)).not.toMatch(/email|phone/);
  });

  it("companies only / managers only / no departments / departments at the manager's price", () => {
    const ctx = ctxOf(sec());
    expect(buildFlowActions({ ...newFlow(), bill: "companies" }, ctx)).toEqual([{ type: "set_counts", sector: "كهروميكانيكا", counts: { company: 200 } }, { type: "set_counts", sector: "بترول", counts: { company: 149 } }]);
    expect(buildFlowActions({ ...newFlow(), bill: "managers", dept: "none" }, ctx)).toEqual([{ type: "set_counts", sector: "كهروميكانيكا", counts: { manager: 601 } }, { type: "set_counts", sector: "بترول", counts: { manager: 239 } }]);
    const priced = buildFlowActions({ ...newFlow(), bill: "both", dept: "manager" }, ctx);
    expect(priced.at(-1)).toEqual({ type: "set_unit_price", itemType: "department", unit: "usd", text: "0.35" });
  });

  it("the typed rate, the client and the target total follow; the model's own answers (in his first message) are not asked again", () => {
    const s: FlowState = { ...newFlow(), bill: "both", dept: "none", price: "target", target: { currency: "egp", text: "2000" }, rate: { kind: "typed", rateE4: 560000 }, client: { name: "شركة النور" } };
    const a = buildFlowActions(s, ctxOf(sec()));
    expect(a.slice(-3)).toEqual([{ type: "set_rate", rateE4: 560000 }, { type: "set_client", name: "شركة النور" }, { type: "set_target_total", currency: "egp", text: "2000" }]);
    const pre = prefillFromActions(newFlow(), [{ type: "set_rate", rateE4: 560000 }, { type: "set_doc_type", docType: "invoice" }, { type: "set_target_total", currency: "usd", text: "17" }]);
    expect(pre.state.rate).toEqual({ kind: "typed", rateE4: 560000 });
    expect(pre.state.target).toEqual({ currency: "usd", text: "17" });
    expect(pre.state.price).toBe("target");
    expect(pre.rest).toEqual([{ type: "set_doc_type", docType: "invoice" }]);
  });
});

describe("the department line: a virtual item type at price 0", () => {
  const blank = (): DocForm => ({ ...newDocForm("invoice", "2026-10-31", { rateE4: 565000 }) });
  it("a fifth quick field exists even if the owner has no such item type; its line has no item type, is found by its name and is not a «forgotten price»", () => {
    const q = quickFields(TYPES);
    expect(q.map((x) => x.name)).toEqual(["شركة", "مدير", "بريد إلكتروني", "رقم هاتف", DEPARTMENT_NAME]);
    const dept = q.at(-1)!.type;
    expect(dept).toEqual({ id: "", nameAr: DEPARTMENT_NAME, unitCc: 0 });
    let f = { ...blank(), batches: [{ key: "b1", title: "بترول", summaryOnly: false }] };
    f = setCount(f, "b1", dept, "32");
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toMatchObject({ itemTypeId: null, itemTypeName: DEPARTMENT_NAME, qty: "32", unit: "0" });
    expect(countText(f, "b1", "")).toBe("32");
    expect(otherLines(f, "b1", q)).toEqual([]);              // it has its own box: not an «other line»
    expect(zeroPriceNames(f)).toEqual([]);                    // price 0 on purpose
    expect(formToInput({ ...f, rate: "56.5" }).ok).toBe(true); // and it saves
    expect(setCount(f, "b1", dept, "").lines).toHaveLength(0);
  });

  it("an owner who HAS an item type with that name gets its price", () => {
    const own = [...TYPES, T(5, DEPARTMENT_NAME, 800)];
    const dept = quickFields(own).at(-1)!.type;
    expect(dept.id).toBe(own[4].id);
    const f = setCount({ ...blank(), batches: [{ key: "b1", title: "ب", summaryOnly: false }] }, "b1", dept, "5");
    expect(f.lines[0]).toMatchObject({ itemTypeId: own[4].id, unit: "0.08" });
  });
});

describe("the whole story through the real counting and the one executor", () => {
  it("the owner's two sectors: his usual prices, then a 2,000 EGP target with whole-point prices and the exact difference; departments at price 0", async () => {
    const { sectors } = await ownerSectors();
    const ctx = ctxOf(sectors);
    const state: FlowState = { ...newFlow(), bill: "both", dept: "zero", price: "default", rate: { kind: "saved" }, client: "none" };
    const form = newDocForm("invoice", "2026-10-31", { rateE4: 565000 });
    const first = applyActions(form, buildFlowActions(state, ctx), CTX, draftSummary(form, TYPES).lineIds);
    expect(first.refused).toEqual([]);
    expect(first.form.batches.map((b) => b.title)).toEqual(["كهروميكانيكا", "بترول"]);
    const qtys = first.form.lines.map((l) => [l.itemTypeName, l.qty]);
    expect(qtys).toEqual([["شركة", "200"], ["مدير", "601"], ["شركة", "149"], ["مدير", "239"], [DEPARTMENT_NAME, "32"]]);
    expect(first.after.shown).toEqual(["egp"]);
    expect(zeroPriceNames(first.form)).toEqual([]);

    const target = { ...state, price: "target" as const, target: { currency: "egp" as const, text: "2000" } };
    const second = applyActions(form, buildFlowActions(target, ctx), CTX, draftSummary(form, TYPES).lineIds);
    expect(second.refused).toEqual([]);
    expect(Math.abs((second.after.egp as number) - 200_000)).toBeLessThanOrEqual(200);                       // within 2 EGP of 2,000 (0.1%)
    expect(second.applied.join(" ")).toMatch(/أسعار الوحدة \(نقاط صحيحة\)/);
    expect(second.applied.join(" ")).toMatch(/أقرب إجمالي ممكن|تمامًا/);
    const dept = second.form.lines.find((l) => l.itemTypeName === DEPARTMENT_NAME);
    expect(dept?.unit).toBe("0");                                                                              // departments stay free
    expect(formToInput({ ...second.form }).ok).toBe(true);
    // before and after are both there for the card
    expect(second.before.egp).toBe(0);
  });
});
