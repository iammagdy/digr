import { describe, expect, it, vi } from "vitest";
import { readWorkbook, replay } from "./helpers/agentReplay";
import { COMPANIES, PEOPLE, SLUGS, companiesPage, peopleAnswer, planFlow, request } from "./helpers/a1World";
import { tregResult } from "./helpers/agentFakeWorld";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { executionBudgetUsd } from "../src/lib/agentMission/price";
import type { TregCallOptions } from "../src/functions/shared/tregClient";
// CHANGED (PR 1 part c): the people sheet of «companies and their decision makers» uses the owner's titles (taskContracts.ts): «اسم صانع القرار», «إيميل المسؤول المباشر», «هاتف / محمول المسؤول» and the statuses beside them

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * REPLAY OF THE OWNER'S BENCHMARK SHAPES, through the whole mission (TREG, real estate Egypt in the benchmark; here the A1 world of five Egyptian companies, two decision makers each): the people come with a professional page; the e-mail finder finds 8 of 10; the verifier says every
 * one of them is deliverable; there is NO personal phone (0 of 10 exist in the sources); the company's head-office phone is found by a map search (once per company) and validated as an Egyptian landline. Expected file: 8 e-mails, every one «موثّق»; 10 phones, every one «رقم الشركة»
 * and «موثّق»; the column «نوع الرقم»; the same people, the same delivered count and charge as a run where nothing is found; the spend inside the approved reserve.
 */
const catalog = loadTregCatalog();
const cell = (v: unknown) => String(v ?? "").trim();
const slugIn = (text: string) => SLUGS.find((s) => text.includes(s)) ?? null;
const companyNameOf = (slug: string) => `${["Orascom", "Nile", "Delta", "Cairo", "Suez"][SLUGS.indexOf(slug as any)]} Electromechanical`;

function dispatcher(mode: "benchmark" | "nothing", log: Array<{ capability: string; params: Record<string, unknown> }>, asked: Set<string>) {
  return (o: TregCallOptions) => {
    const capability = catalog.byId.get(o.endpointId)?.capability ?? "";
    log.push({ capability, params: (o.params ?? {}) as Record<string, unknown> });
    if (o.endpointId === COMPANIES) return tregResult(companiesPage, 0.0005);
    if (o.endpointId === PEOPLE) return peopleAnswer(o);
    const who = JSON.stringify(o.params ?? {});
    if (mode === "nothing") return tregResult({ found: false }, 0);
    if (capability === "people.email.find") {
      // 8 of 10 found: the 2nd and the 7th person asked are the finder's misses (as in the benchmark: 8 of 10)
      const slug = slugIn(who);
      // the person, whichever finder is asked (the first and the fallback take the page under different input names)
      // CHANGED (owner decision after #321: finders are ranked by measured cost per hit): the chain now holds a finder that takes the person's NAME and the company's domain (no profile link); its person is the same one: first name -> index, domain -> company
      const FIRST = ["Hossam", "Mona", "Ahmed", "Salma", "Karim", "Nadia", "Tamer"];
      const p = (o.params ?? {}) as Record<string, unknown>;
      const nameSlug = SLUGS.find((s) => String(p.company_domain ?? "").includes(s));
      const nameIndex = FIRST.indexOf(String(p.first_name ?? ""));
      const url = /\/in\/([a-z-]+-\d)/.exec(who)?.[1] ?? (nameSlug && nameIndex >= 0 ? `${nameSlug}-${nameIndex}` : who);
      asked.add(url);
      const order = [...asked].indexOf(url);
      return slug && order !== 1 && order !== 6 ? tregResult({ found: true, email: `person${order}.${slug}@${slug}.com.eg` }, 0.000495) : tregResult({ found: false }, 0);
    }
    if (capability === "people.email.verify") return tregResult({ status: "safe", deliverable: true, is_catch_all: false }, 0.00178);
    if (capability === "people.phone.find" || capability === "people.phone.find.personal") return tregResult({ found: false }, 0);
    if (capability === "google.serp.maps") {
      const slug = SLUGS.find((s) => who.includes(companyNameOf(s)));
      return slug ? tregResult({ places: [{ title: `${companyNameOf(slug)} Head Office`, website: `https://${slug}.com.eg`, phone: `+20 2 ${3000 + SLUGS.indexOf(slug)} 4567` }, { title: "Unrelated Cafe", phone: "+20 2 9999 9999" }] }, 0.00015) : tregResult({ places: [] }, 0);
    }
    if (capability === "people.phone.verify") {
      const n = String((o.params as any)?.telephone_number ?? "");
      return tregResult({ results: [{ error: "NONE", detected_telephone_number: n, telephone_number_type: "LANDLINE", original_network_details: { country_iso3: "EGY", country_prefix: "20" } }] }, 0);
    }
    return peopleAnswer(o);
  };
}
const run = (mode: "benchmark" | "nothing") => {
  const log: Array<{ capability: string; params: Record<string, unknown> }> = [];
  const asked = new Set<string>();
  return replay({ request, planning: planFlow(), execution: () => [], answers: Array.from({ length: 160 }, () => dispatcher(mode, log, asked)) }).then((r) => ({ r, log }));
};
async function peopleSheet(r: Awaited<ReturnType<typeof replay>>) {
  const sheet = (await readWorkbook(r)).worksheets[2];
  const header = (sheet.getRow(1).values as unknown[]).map(cell);
  const rows = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2));
  return { header, n: rows.length, col: (title: string) => rows.map((row) => cell(row.getCell(header.indexOf(title)).value)) };
}

describe("the benchmark shapes, through a whole mission", () => {
  it("8 of 10 e-mails, all verified; no personal phone, so every person carries their company's head-office phone, labelled and validated as local", async () => {
    const { r, log } = await run("benchmark");
    const s = await peopleSheet(r);
    expect(s.n).toBe(10);
    const emails = s.col("إيميل المسؤول المباشر");
    const emailStatus = s.col("حالة توثيق إيميل المسؤول المباشر");
    expect(emails.filter(Boolean).length).toBe(8);
    emails.forEach((e, i) => expect(emailStatus[i]).toBe(e ? "موثّق" : ""));
    const phones = s.col("هاتف / محمول المسؤول");
    expect(phones.filter(Boolean).length).toBe(10);
    expect(new Set(s.col("حالة توثيق هاتف / محمول المسؤول"))).toEqual(new Set(["موثّق"]));
    expect(new Set(s.col("نوع الرقم"))).toEqual(new Set(["رقم الشركة"]));
    // the type column sits right after the phone's status column
    expect(s.header.indexOf("نوع الرقم")).toBe(s.header.indexOf("حالة توثيق هاتف / محمول المسؤول") + 1);
    // two decision makers of one company share the company's phone, found by ONE search per company
    expect(log.filter((l) => l.capability === "google.serp.maps").length).toBe(5);
    expect(log.filter((l) => l.capability === "people.email.verify").length).toBe(8);
  });

  it("the same people, the same delivered count and the same charge as a run where nothing is found; the spend stays inside the approved reserve", async () => {
    const none = (await run("nothing")).r;
    const { r } = await run("benchmark");
    expect(r.mission.delivered_units).toBe(none.mission.delivered_units);
    expect(r.mission.charged_points).toBe(none.mission.charged_points);
    expect(Number(r.mission.charged_points)).toBeLessThanOrEqual(Number(r.mission.reserved_points));
    expect(Number(r.mission.execution_treg_usd)).toBeLessThanOrEqual(executionBudgetUsd(Number(r.mission.reserved_points)) + 1e-9);
  });

  it("nothing found: the people are delivered, every contact cell is empty, and nothing claims «موثّق»", async () => {
    const { r } = await run("nothing");
    const s = await peopleSheet(r);
    expect(s.n).toBe(10);
    for (const title of ["إيميل المسؤول المباشر", "هاتف / محمول المسؤول", "حالة توثيق إيميل المسؤول المباشر", "حالة توثيق هاتف / محمول المسؤول", "نوع الرقم"]) expect(s.col(title).filter(Boolean).length).toBe(0);
  });
});
