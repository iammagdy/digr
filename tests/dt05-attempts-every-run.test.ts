import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import type { ContactStep, FinderInfo } from "../src/lib/agentMission/contactFinders";
import { createJobCallBudget } from "../src/lib/server/callBudget";

/**
 * QA #575 FAIL 3 + BUG HUNTER Gate 2 P2 (DT-20261118-05 item 3: the attempts file on EVERY run). A stop in the company stage returned before the people steps were made, so no attempts file said why every person was left empty; a failed write
 * was swallowed; only the step that saw the stop said why; a resumed run, whose people already had their final cells, overwrote the file with nothing.
 */
const MISSION = "msn_dt05_attempts";
const MAPS: FinderInfo = { id: "fake.google.serp.maps", usd: 0.00015, inputs: [{ name: "query", required: true }] };
const MAIL: FinderInfo = { id: "fake.people.email.by_name_domain", usd: 0.0005, bill: "success", inputs: [{ name: "domain", required: true }, { name: "full_name", required: false }] };
const PHONE: FinderInfo = { id: "fake.people.phone.by_any", usd: 0.0263, bill: "success", inputs: [{ name: "domain", required: false }, { name: "name", required: false }] };
const PEOPLE = [{ id: "p1", full_name: "Mina Naguib" }, { id: "p2", full_name: "Sara Adel" }];

async function world(opts: { companyStep?: boolean; answers: (endpoint: string) => "daily_cap" | unknown; failWrites?: boolean }) {
  const memory = createMemoryStore();
  const store = new Proxy(memory, {
    get(target, prop, receiver) {
      if (prop === "putFile" && opts.failWrites) return async (m: string, p: string, c: string, t: string) => { if (p.startsWith("contacts/")) throw new Error("storage down"); return target.putFile(m, p, c, t); };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const items = await ItemStore.open(store, MISSION);
  await items.commit([
    { t: "item", stage: "companies", id: "c1", state: "accepted", by: "rule", row: { id: "c1", name: "Falcon Misr", website: "https://www.falconmisr.com/", country: "EG" } as any },
    ...PEOPLE.map((p) => ({ t: "item" as const, stage: "people", id: p.id, state: "accepted" as const, by: "rule" as const, row: { parent_id: "c1", email: "", phone: "", ...p } })),
  ]);
  const company: ContactStep = { kind: "phone", level: "company", stage_key: "companies", column_key: "company_phone", status_key: "company_phone_status", per_person_usd: 0.00015, max_person_usd: 0.0035, finders: [], company_phone: [MAPS] };
  const email: ContactStep = { kind: "email", stage_key: "people", column_key: "email", status_key: "email_status", per_person_usd: 0.0005, finders: [MAIL] };
  const phone: ContactStep = { kind: "phone", stage_key: "people", column_key: "phone", status_key: "phone_status", type_key: "phone_type", per_person_usd: 0.03, max_person_usd: 0.03, finders: [PHONE] } as ContactStep;
  const plan: any = {
    stages: [
      { key: "companies", parent_key: null, title_ar: "الشركات", deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }, { key: "company_phone", title_ar: "هاتف المقر الرئيسي" }], planned_rows: 1 },
      { key: "people", parent_key: "companies", title_ar: "صناع القرار", deliver: true, columns: [{ key: "full_name", title_ar: "الاسم" }, { key: "email", title_ar: "الإيميل", kind: "work_email" }, { key: "phone", title_ar: "رقم التليفون", kind: "phone" }], planned_rows: 2 },
    ],
    contact_steps: [...(opts.companyStep ? [company] : []), email, phone],
  };
  const calls: string[] = [];
  let n = 0;
  const gateway: any = {
    async tregCall(a: { endpoint_id: string }) {
      calls.push(a.endpoint_id);
      const out = opts.answers(a.endpoint_id);
      const id = `call_${String(++n).padStart(4, "0")}`;
      if (out === "daily_cap") return { ok: false, call_id: id, refused: "daily_cap" };
      await memory.putFile(MISSION, `raw/${id}.json`, JSON.stringify(out ?? {}), "application/json");
      return { ok: true, call_id: id, http_status: 200, rows_in_page: out ? 1 : 0, has_more: false, next_cursor: null };
    },
  };
  const logged: string[] = [];
  const run = () => runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async () => {}, budget: createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 }), deadlineMs: Date.now() + 60_000, log: (line: string) => logged.push(line) });
  const file = async (kind: "email" | "phone") => JSON.parse((await memory.getFile(MISSION, `contacts/attempts_people_${kind}.json`)) ?? "null");
  return { run, file, calls, logged };
}

describe("DT-20261118-05 item 3: the attempts file is written on every run, with the reason the run stopped", () => {
  it("a stop in the COMPANY stage still writes every people step's file: nobody reached, and why", async () => {
    const w = await world({ companyStep: true, answers: (ep) => (ep === MAPS.id ? "daily_cap" : null) });
    const out = await w.run();
    expect(out.stopped).toBe("daily_cap");
    expect(w.calls).toEqual([MAPS.id]);
    expect(await w.file("email")).toEqual({ outcomes: {}, people: 2, stopped: "daily_cap", not_reached: 2 });
    expect(await w.file("phone")).toEqual({ outcomes: {}, people: 2, stopped: "daily_cap", not_reached: 2 });
  });
  it("a stop seen by the e-mail step is the phone step's stop too: both files say why, and how many people were never reached", async () => {
    const w = await world({ answers: (ep) => (ep === MAIL.id ? "daily_cap" : null) });
    await w.run();
    expect(await w.file("email")).toMatchObject({ stopped: "daily_cap", people: 2, not_reached: 1 });
    expect(await w.file("phone")).toEqual({ outcomes: {}, people: 2, stopped: "daily_cap", not_reached: 2 });
  });
  it("a resumed run whose people already have their final cells keeps what the first run recorded", async () => {
    const w = await world({ answers: (ep) => (ep === PHONE.id ? { data: { phone: "+201001234567" } } : null) });
    await w.run();
    const first = await w.file("phone");
    expect(first.outcomes[`${PHONE.id}|value`]).toBe(2);
    await w.run();
    expect((await w.file("phone")).outcomes).toEqual(first.outcomes);
  });
  it("a failed write is logged with the file's path, and the run still ends normally", async () => {
    const w = await world({ failWrites: true, answers: () => null });
    const out = await w.run();
    expect(out.stopped).toBeNull();
    expect(w.logged.some((l) => l.startsWith("contact_file_write_failed") && l.includes("contacts/attempts_people_phone.json") && l.includes("storage down"))).toBe(true);
  });
});
