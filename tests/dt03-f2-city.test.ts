import { describe, expect, it } from "vitest";
import { placeVerdict } from "../src/lib/agentMission/places";
import { filterVerdict } from "../src/lib/agentMission/filters";

/**
 * DT-20261118-03 F2-b (live, chat B): «في القاهرة» delivered at least two companies in Giza. A city of the same country was never evidence AGAINST the item, so the source's own place filter (by_source) or one field naming Cairo let a
 * Giza address through. Now a text that names another city of the same country rejects the item when a city was asked.
 */
const fields = ["city", "address"];
describe("DT-20261118-03 F2-b: a city request keeps the other cities of the country out", () => {
  it.each([
    [{ address: "الشيخ زايد، الجيزة" }, true],
    [{ address: "6th of October City, Giza" }, false],
    [{ city: "Cairo", address: "Sheikh Zayed, Giza" }, false],
    [{ city: "Cairo", address: "Alexandria Desert Road, Alexandria" }, true],
  ])("%j (asked of the source: %s) is another place", (row, bySource) => {
    expect(placeVerdict(["EG:cairo"], row, fields, { bySource })).toBe("other_place");
    expect(filterVerdict([{ kind: "place", places: ["EG:cairo"], fields, by_source: bySource } as never], row, { textKey: null, now: 0 } as never)).toBe("filter_place");
  });
  it("Cairo itself, a source asked for Cairo with no text, and a country request are unchanged", () => {
    expect(placeVerdict(["EG:cairo"], { address: "التجمع الخامس، القاهرة" }, fields)).toBe("pass");
    expect(placeVerdict(["EG:cairo"], { city: "Cairo" }, fields, { bySource: true })).toBe("pass");
    expect(placeVerdict(["EG:cairo"], {}, fields, { bySource: true })).toBe("pass");
    expect(placeVerdict(["EG"], { address: "الشيخ زايد، الجيزة" }, fields)).toBe("pass");
  });
  it("P1-B: a row passes when the same field names the asked city even if it also names a district or road mapped to another city", () => {
    const passingRows = [
      { address: "Dokki, Cairo" },
      { address: "Dokki, Cairo, Egypt" },
      { address: "الدقي، القاهرة" },
      { address: "المهندسين، القاهرة" },
      { address: "المهندسين، القاهرة، مصر" },
      { address: "15 Faisal Street, Cairo" },
      { address: "Km 28 Cairo-Alexandria Desert Road, Cairo" },
      { address: "Mohandessin, Cairo" },
      { address: "طريق القاهرة الإسكندرية الصحراوي، القاهرة" },
    ];
    for (const row of passingRows) {
      expect(placeVerdict(["EG:cairo"], row, fields)).toBe("pass");
    }
    // {city: "Cairo", address: "Sheikh Zayed, Giza"} stays other_place because the address field names another city and NOT Cairo
    expect(placeVerdict(["EG:cairo"], { city: "Cairo", address: "Sheikh Zayed, Giza" }, fields)).toBe("other_place");
  });
});
