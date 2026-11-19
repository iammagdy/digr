import { expect, it } from "vitest";
import { ItemStore } from "../agent/src/items/itemStore";
import { createMemoryStore } from "../agent/src/memoryStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import { buildContactSteps, foundContactIn, type ContactStep, type FinderInfo } from "../src/lib/agentMission/contactFinders";
import { b2bContactCells, createAttemptLog } from "../src/lib/agentMission/stage3/b2bEngine";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { createJobCallBudget } from "../src/lib/server/callBudget";

const MISSION = "msn_07b_fixture";
const office = "+20 2 2345 6789";
const mobile = "+201001234567";
const work = "person@company.example";
const finder = (id: string, input = "full_name"): FinderInfo => ({ id, usd: 0.01, bill: "success", inputs: [{ name: input, required: true }] });
const A = finder("finder.a");
const B = finder("finder.b");
const X = finder("finder.x");
const V = finder("validator", "phone");
const verified = { results: [{ error: "NONE", telephone_number_type: "MOBILE", original_network_details: { country_iso3: "EGY" } }] };
const phone = (fields: Partial<ContactStep> = {}): ContactStep => ({ kind: "phone", stage_key: "people", column_key: "phone", status_key: "phone_status", type_key: "phone_type", per_person_usd: 0.05, finders: [A], ...fields });
const email = (fields: Partial<ContactStep> = {}): ContactStep => ({ kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: 0.05, finders: [A], ...fields });
const columns = [{ key: "full_name", title_ar: "الاسم" }, { key: "email", title_ar: "الإيميل", kind: "work_email" as const }, { key: "phone", title_ar: "رقم التليفون", kind: "phone" as const }];
async function world(steps: ContactStep[], answers: (id: string, params: Record<string, string>) => unknown,
  opts: { people?: number; given?: Record<string, string>; log?: boolean; ceiling?: number; expire?: boolean; meter?: (id: string, page: unknown) => number } = {}) {
  const itemsStore = createMemoryStore();
  const items = await ItemStore.open(itemsStore, MISSION);
  await items.commit([{ t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { id: "c1", name: "Company", website: "company.example", country: "EG" } },
    ...Array.from({ length: opts.people ?? 1 }, (_, i) => ({ t: "item" as const, stage: "people", id: `p${i + 1}`, state: "accepted" as const, by: "rule" as const, row: { id: `p${i + 1}`, parent_id: "c1", full_name: `Person ${i + 1}`, email: "", phone: "", ...opts.given } }))]);
  const plan = { stages: [{ key: "companies", parent_key: null, title_ar: "الشركات", columns: [{ key: "name", title_ar: "الاسم" }] },
    { key: "people", parent_key: "companies", title_ar: "صناع القرار", columns }], contact_steps: steps } as Parameters<typeof runContactEnrichment>[0]["plan"];
  const budget = createJobCallBudget({ ceilingUsd: opts.ceiling ?? 1, spentUsd: 0 });
  const calls: Array<{ id: string; params: Record<string, string> }> = [];
  const attempts = opts.log ? createAttemptLog() : undefined;
  const gateway: Parameters<typeof runContactEnrichment>[0]["gateway"] = {
    async tregCall({ endpoint_id, params }) {
      const id = String(endpoint_id);
      calls.push({ id, params: params as Record<string, string> });
      const page = answers(id, params as Record<string, string>);
      const call_id = `call_${calls.length}`;
      if (page === "refused") return { ok: false, call_id, refused: "daily_cap", message: "fixture" };
      if (page === "failed") return { ok: false, call_id, failed: true, http_status: 503, message: "fixture" };
      if (page !== "raw_missing") await itemsStore.putFile(MISSION, `raw/${call_id}.json`, JSON.stringify(page), "application/json");
      budget.settle(0, opts.meter?.(id, page) ?? 0);
      return { ok: true, call_id, http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: `raw/${call_id}.json` };
    },
  };
  const row = (id = "p1") => items.acceptedRows("people").find((r) => r.id === id)!;
  const ids = () => calls.map((c) => c.id);
  const run = () => runContactEnrichment({ items, store: itemsStore, plan, missionId: MISSION, gateway, budget,
    addEvent: async () => {}, deadlineMs: Date.now() + (opts.expire ? -1 : 60_000), attempts, provenance: true });
  return { row, ids, run, calls, attempts, items, plan, file: async (path: string) => JSON.parse((await itemsStore.getFile(MISSION, path)) ?? "null") };
}

it.each([
  [{ office_phone: office }, "رقم الشركة"], [{ HQPhone: office }, "رقم الشركة"], [{ main_line: office }, "رقم الشركة"],
  [{ company: { phone: office } }, "رقم الشركة"], [{ home_phone: office }, "رقم الشركة"], [{ business_phone: office }, "رقم الشركة"],
  [{ phone_numbers: [{ number: office, type: "office" }] }, "رقم الشركة"], [{ fax_number: office }, "فاكس"],
])("P4 office-only %j keeps %s without validation", async (page, type) => {
  const w = await world([phone({ finders: [A, B], validators: [V] })], (id) => id === A.id ? page : {});
  expect((await w.run()).filled.phone).toBe(1);
  expect(w.row()).toMatchObject({ phone: office, phone_type: type, phone_status: "غير موثّق", _call_phone: "call_1" });
  expect(w.ids()).toEqual([A.id, B.id]);
  expect(foundContactIn("phone", page)).toBeNull();
});

it("P4 an older phone step without a type column labels the fax in status and asks again on rerun", async () => {
  let answer: Record<string, unknown> = { fax_number: office };
  const w = await world([phone({ type_key: undefined, validators: [V] })], () => answer);
  await w.run();
  expect(w.row()).toMatchObject({ phone: office, phone_status: "غير موثّق — فاكس" });
  answer = {};
  expect((await w.run()).filled.phone).toBe(0);
  expect(w.row()).toMatchObject({ phone: office, phone_status: "غير موثّق — فاكس" });
  expect(w.ids()).toEqual([A.id, A.id]);
  answer = { phone: mobile };
  await w.run();
  expect(w.row()).toMatchObject({ phone: mobile, phone_status: `غير موثّق — فاكس: ${office}`, _call_phone: "call_3" });
});

it("P4 a later primary finder puts a personal phone in the cell and moves the fax into the status", async () => {
  const w = await world([phone({ finders: [A, B], validators: [V] })],
    (id) => id === A.id ? { fax_number: office } : id === B.id ? { phone: mobile } : verified);
  expect((await w.run()).filled.phone).toBe(1);
  expect(w.row()).toMatchObject({ phone: mobile, phone_type: "شخصي", phone_status: `موثّق — فاكس: ${office}`, _call_phone: "call_2" });
  expect(w.ids()).toEqual([A.id, B.id, V.id]);
});

it("P4 a rerun asks after an office hit, promotes a personal phone and keeps the note on a final rerun", async () => {
  let answer: Record<string, unknown> = { office_phone: office };
  const w = await world([phone({ finders: [A], validators: [V] })], (id) => id === V.id ? verified : answer);
  await w.run();
  expect(w.row().phone).toBe(office);
  expect(w.ids()).toEqual([A.id]);
  answer = {};
  await w.run();
  expect(w.row()).toMatchObject({ phone: office, phone_type: "رقم الشركة", _call_phone: "call_1" });
  expect(w.ids()).toEqual([A.id, A.id]);
  answer = { phone: mobile };
  await w.run();
  expect(w.row()).toMatchObject({ phone: mobile, phone_type: "شخصي", phone_status: `موثّق — رقم الشركة: ${office}`, _call_phone: "call_3" });
  await w.run();
  expect(w.ids()).toEqual([A.id, A.id, A.id, V.id]);
});

it.each([
  [{ phoneContact: "01001234567" }, "01001234567"],
  [{ value: "+20 100 123 4567" }, "+20 100 123 4567"],
  [{ cell_phone: "01001234567" }, "01001234567"],
])("P5 eligible fallback shape %j is delivered unchanged", async (page, value) => {
  const w = await world([phone()], () => page);
  await w.run();
  expect(w.row()).toMatchObject({ phone: value, phone_type: "شخصي", phone_status: "غير موثّق" });
});

it.each([
  { personId: "0012345678901" }, { employeeId: { phone: mobile } }, { createdAt: "0000000000" },
  { updatedAt: mobile }, { postalCode: "0123456789" }, { foundedYear: "2024" }, { employeeCount: "0012345678" },
  { registration_number: "0123456789012" }, { tracking_no: "0123456789" }, { reference: "0123456789" },
  { ein: "0123456789" }, { sku: "0123456789" }, { longitude: "031.23570012" }, { ip: "010.020.030.040" },
  { value: "01001234567" }, { mobileIp: "010.020.030.040" }, { mobileValue: "031.23570012" },
  { national_id: mobile }, { linkedin_id: mobile }, { whatsapp_link_id: mobile }, { id: mobile },
  { mobileValue: "2026-11-19" }, { phone: "19/11/2026" }, { mobileValue: "1700000000" },
  { price: mobile }, { phone: "12.50" }, { phone: "+1" }, { phone: "+20 ***" }, { contact: 201001234567 },
])("P5 rejects non-phone %j", (page) => {
  expect(foundContactIn("phone", page)).toBeNull();
});

it.each([["home", "mobile"], ["unknown", "work"]])("P6 rank %s loses to %s", (type, label) => {
  const page = { phone_numbers: [{ number: "+201001111111", type }, { number: mobile, label }] };
  expect(foundContactIn("phone", page)?.value).toBe(mobile);
});
it("P6 equal ranks keep wire order, and recognised numeric phone fields still work", () => {
  expect(foundContactIn("phone", { phones: [{ number: 201001234567 }, { number: "+201001111111" }] })?.value).toBe("201001234567");
});

it("P6 junk has only finder/call IDs and counts, with typed or truncated scan diagnostics", async () => {
  const w = await world([phone()], () => ({ phone: "19/11/2026", contact: 201001234567, extras: Array.from({ length: 41 }, () => "x") }));
  expect((await w.run()).filled.phone).toBe(0);
  expect(await w.file("contacts/rejected_people_phone.json")).toEqual({ "finder.a|call_1": { rejected: 1, number_typed: 1, scan_truncated: 1 } });
});

it.each([
  ["answered", B, {}, false, "غير متوفر"],
  ["junk answered", B, { email: "j***@company.example" }, false, "غير متوفر"],
  ["failed", B, "failed", false, ""],
  ["refused", B, "refused", false, ""],
  ["unreadable answer", B, "raw_missing", false, ""],
  ["missing input", finder("finder.profile", "linkedin"), {}, false, ""],
  ["expired before call", B, {}, true, ""],
] as const)("P7 %s produces the same engine cell with and without the attempt log", async (_name, second, answer, expire, expected) => {
  for (const log of [false, true]) {
    const w = await world([email({ finders: [A, second] })], (id) => id === A.id ? { email: null } : answer, { log, expire });
    expect((await w.run()).filled.email).toBe(0);
    expect(w.row().email).toBe(expected);
  }
});

it("P7 re-asks after an unavailable marker, replaces it with a found value, and never overwrites the value", async () => {
  let second = false;
  const w = await world([email(), phone({ finders: [finder("phone.by.email", "email")] })], (id) => id === A.id && second ? { email: work } : {});
  await w.run();
  expect(w.row().email).toBe("غير متوفر");
  expect(w.ids()).toEqual([A.id]);
  second = true;
  await w.run();
  expect(w.row().email).toBe(work);
  second = false;
  await w.run();
  expect(w.row().email).toBe(work);
  expect(w.calls.filter((c) => c.id === "phone.by.email").map((c) => c.params.email)).toEqual([work, work]);
});

it("L1 uses the stored alternate after all three primary finders answer empty", async () => {
  const chain = [A, B, finder("finder.c")];
  const w = await world([email({ finders: chain, alternates: [X] })], (id) => id === X.id ? { email: work } : {});
  expect((await w.run()).filled.email).toBe(1);
  expect(w.ids()).toEqual([A.id, B.id, "finder.c", X.id]);
  expect(w.row().email).toBe(work);
});

it("L1 gives all five people their primary call before alternates spend the twelve-call budget", async () => {
  const primary = { ...A, bill: "call" } as const;
  const chain = [primary, finder("chain.profile", "linkedin"), finder("chain.email", "email")];
  const alternates = [X, finder("finder.y"), finder("finder.z")].map((f) => ({ ...f, bill: "call" as const }));
  const w = await world([email({ finders: chain, alternates })],
    (id) => id === "finder.y" ? { email: work } : {}, { people: 5, ceiling: 0.12, meter: () => 0.01 });
  const out = await w.run();
  expect(w.ids()).toEqual([...Array(5).fill(A.id), X.id, "finder.y", X.id, "finder.y", X.id, "finder.y", X.id]);
  expect(new Set(w.calls.slice(0, 5).map((c) => c.params.full_name)).size).toBe(5);
  expect(out.filled.email).toBe(3);
  expect(out.stopped).toBe("budget");
  expect(w.row("p5").email).toBe("");
});

it("L1 keeps an unvalidated office result when another person's primary chain stops the alternate pass", async () => {
  const w = await world([phone({ alternates: [X], validators: [V] })],
    (_id, params) => String(params.full_name).endsWith("1") ? { office_phone: office } : "refused", { people: 2 });
  expect((await w.run()).stopped).toBe("daily_cap");
  expect(w.row()).toMatchObject({ phone: office, phone_type: "رقم الشركة" });
  expect(w.row("p2").phone).toBe("");
  expect(w.ids()).toEqual([A.id, A.id]);
});

it("L1 an answered primary hit skips alternates, and an unaffordable alternate cannot run", async () => {
  const success = await world([email({ alternates: [X] })], () => ({ email: work }));
  await success.run();
  expect(success.ids()).toEqual([A.id]);
  const noRoom = await world([email({ finders: [{ ...A, bill: "call" }], alternates: [X] })], () => ({}));
  await noRoom.run();
  expect(noRoom.ids()).toEqual([A.id]);
  expect(noRoom.row().email).toBe("");
  expect((await noRoom.file("contacts/attempts_people_email.json")).outcomes).toMatchObject({ "finder.x|not_tried:person_budget": 1 });
});

it("L1 calls at most three extra alternates and records failed alternates as incomplete under Stage 3", async () => {
  const alternates = [X, finder("finder.y"), finder("finder.z"), finder("finder.extra")];
  const w = await world([email({ alternates })], (id) => id === X.id ? "failed" : {}, { log: true });
  await w.run();
  expect(w.ids()).toEqual([A.id, X.id, "finder.y", "finder.z"]);
  expect(w.row().email).toBe("");
  const ops = b2bContactCells(w.plan, { people: w.items.acceptedRows("people") }, w.attempts!);
  expect(ops[0].cells.email).toBe("لم يكتمل البحث");
});

it("L1 stores ranked e-mail alternates without changing the primary chain expectation or cap", () => {
  const stages = [{ key: "people", title_ar: "صناع القرار", parent_key: "companies", deliver: true, columns }];
  const base = buildContactSteps(stages, undefined, () => [A])[0];
  const next = buildContactSteps(stages, undefined, () => [A], () => ({ alternates: [X] }))[0];
  expect(base.kind).toBe("email");
  expect(next).toEqual({ ...base, alternates: [X] });
});

it.each(["رقم الشركة", "فاكس", "إيميل مشترك", "إيميل شخصي", "غير متوفر"])("customer contact label %s passes the existing text guard", (label) => {
  expect(checkCustomerText(label).issues).toEqual([]);
});
