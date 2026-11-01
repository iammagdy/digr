import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { request } from "./helpers/a1World";
import { liveDispatcher, liveFlow } from "./helpers/g1R2World";
import { filterVerdict, type StageFilter } from "../src/lib/agentMission/filters";
import { countryOfValue, placeKeysOfValues, placeVerdict } from "../src/lib/agentMission/places";

/**
 * GOLDEN RUN ROUND 2, G1 (TEST account, 2026-11-01 15:35 UTC, msn_9dc8f2db86bc5cf4959b): «عايز ٥ شركات مصرية في قطاع الكهروميكانيكا ...» delivered 2 companies and 1 person (3 of 15). The source (tomba companies, asked for
 * location_country EG) gave 242 companies; 240 were left out as «من مكان غير الذي حددته». The stored plan carried ONE filter, written by the planner: {kind: "place", field: "city", values: ["EG"]}, with NO `places` keys and NO `fields`:
 * the plan check could not read «EG» as a place (a two-letter name is not matched in a text, and «مصرية» is a nationality, not a place), so the filter stayed the planner's raw one, and the engine compared the CITY cell («al qahirah», «giza»)
 * with the text «EG» (filters.ts, the no-`places` branch): only a city whose text happened to contain «eg» passed. A plan with NO planner-declared place filter (msn_ecca2a0d074fef9f4456, 13:12 UTC) never met this.
 *
 * THIS FILE IS A PERMANENT REGRESSION TEST: the live shape of the filter, the live shape of the rows (city in Latin letters, country empty or free text, no location field at all), and the source's own country filter.
 */
const LIVE_FILTER: StageFilter = { kind: "place", field: "city", values: ["EG"] };

describe("a place filter reads the requested country in any form (unit, the live filter)", () => {
  it("resolves «EG», «Egypt», «مصر» and a nationality word to the country key; an unknown word to none", () => {
    expect(placeKeysOfValues(["EG"])).toEqual(["EG"]);
    expect(placeKeysOfValues(["egy"])).toEqual(["EG"]);
    expect(placeKeysOfValues(["Egypt"])).toEqual(["EG"]);
    expect(placeKeysOfValues(["مصر"])).toEqual(["EG"]);
    expect(placeKeysOfValues(["مصرية"])).toEqual(["EG"]);
    expect(placeKeysOfValues(["القاهرة"])).toEqual(["EG:cairo"]);
    expect(placeKeysOfValues(["Narnia"])).toEqual([]);
    expect(countryOfValue("EG")).toBe("EG");
  });

  it("LIVE: the stored filter (no places, no fields) passes every Egyptian shape of a row and still refuses another country", () => {
    const pass = (row: Record<string, unknown>) => filterVerdict([LIVE_FILTER], row, { textKey: null, now: 0 });
    expect(pass({ city: "al qahirah", country: "EG" })).toBeNull();
    expect(pass({ city: "giza", country: "EG" })).toBeNull();
    expect(pass({ city: "Faiyum Egypt", country: "" })).toBeNull();
    expect(pass({ city: "", country: "egypt" })).toBeNull();
    expect(pass({ city: "", country: "EGY" })).toBeNull();
    expect(pass({ city: "Cairo, EG", country: "" })).toBeNull();
    expect(pass({ city: "6th of October", address: "1234 egypt" })).toBeNull();
    expect(pass({ city: "Berlin", country: "DE" })).toBe("filter_place");
    // no location evidence at all: not delivered by the row alone (the source's own filter is what keeps it, below)
    expect(pass({ city: "", country: "", address: "" })).toBe("filter_place");
  });

  it("a row with no location field passes when the SOURCE query was restricted to the country (by_source), and another country still does not", () => {
    const bySource = { ...LIVE_FILTER, by_source: true };
    expect(filterVerdict([bySource], { city: "", country: "" }, { textKey: null, now: 0 })).toBeNull();
    expect(filterVerdict([bySource], { city: "Berlin", country: "DE" }, { textKey: null, now: 0 })).toBe("filter_place");
  });

  it("the table's own verdict for the same forms", () => {
    expect(placeVerdict(["EG"], { country: "EG" }, ["country"])).toBe("pass");
    expect(placeVerdict(["EG"], { city: "al qahirah" }, ["city"])).toBe("pass");
  });
});

describe("G1 round 2 replay: the live place filter and the live rows", () => {
  it("5 of 5 companies pass; the German one is the only row left out; the closing sentence never says «from another place» about the Egyptian ones", async () => {
    const r = await replay({ request, planning: liveFlow(), execution: () => [], answers: Array.from({ length: 200 }, () => liveDispatcher()) });
    assertReplayInvariants(r);
    const wb = await readWorkbook(r);
    const companies = wb.worksheets[1];
    const names = Array.from({ length: companies.rowCount - 1 }, (_, k) => String(companies.getRow(k + 2).getCell(2).value ?? "")).filter(Boolean);
    expect(names.length).toBe(5);
    expect(names.some((n) => /Berlin/.test(n))).toBe(false);
    const stage = r.plannedPlan.stages.find((s) => s.key === "companies")!;
    // the stored filter now names its places and says the country in Arabic (the card never shows «EG»)
    const place = (stage.filters ?? []).find((f) => f.kind === "place")!;
    expect(place.places).toEqual(["EG"]);
    expect((place.values ?? []).join(" ")).not.toMatch(/[A-Za-z]/);
    // the one German company is the only row the place rule left out
    const companyStage = (await r.store.getMission(r.missionId))?.summary_ar ?? "";
    expect(companyStage).not.toContain("٢٤٠");
  });
});
