import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAll, totals, type Fixture } from "../src/lib/server/extractionBenchmark";
import { renderBenchmarkMarkdown } from "../src/lib/server/extractionBenchmarkReport";

/**
 * B7. The offline benchmark: saved raw rows per capability replayed through the gate, de-duplication and Excel
 * normalisation. These assertions turn the benchmark into a regression gate, and the committed document must match it.
 */
const dir = path.resolve(__dirname, "fixtures/extraction");
const fixtures: Fixture[] = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("baseline")).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
const baseline = JSON.parse(readFileSync(path.join(dir, "baseline-before.json"), "utf8"));

describe("extraction benchmark", () => {
  it("covers every capability family: companies, tweets, comments (3 platforms), videos (2), posts, decision makers", () => {
    expect(fixtures.map((f) => f.capability).sort()).toEqual([
      "icypeas-companies-search", "professional-people-search", "social-facebook-comments", "social-facebook-posts",
      "social-tiktok-comments", "social-tiktok-videos", "social-x-posts", "social-youtube-comments", "social-youtube-videos",
    ]);
    for (const f of fixtures) expect(f.rows.length).toBeGreaterThanOrEqual(5);
  });

  it("no capability delivers a row a reviewer would have held back or dropped, and none loses a real match", async () => {
    const results = await runAll(fixtures);
    for (const r of results) {
      expect(r.falseDeliveries, `${r.capability} false deliveries`).toBe(0);
      expect(r.lostMatches, `${r.capability} lost matches`).toBe(0);
      expect(r.agreement, `${r.capability} agreement`).toBe(r.rowsIn);
    }
  });

  it("every delivered Excel has Arabic headers only, plain dates and numeric counts", async () => {
    const results = await runAll(fixtures);
    for (const r of results) {
      expect(r.latinHeaders, `${r.capability} Latin headers`).toEqual([]);
      expect(r.formatIssues, `${r.capability} format issues`).toBe(0);
    }
  });

  it("it is measurably better than the gate and de-duplication it replaced (recorded from main e7cf565)", async () => {
    const after = totals(await runAll(fixtures));
    const before = totals(baseline.results);
    expect(after.agreement).toBeGreaterThan(before.agreement);
    expect(after.falseDeliveries).toBeLessThan(before.falseDeliveries);
    expect(after.lostMatches).toBeLessThan(before.lostMatches);
  });

  it("decision makers: only requested fields that came back are charged; a person with none costs nothing; a duplicate person is dropped", async () => {
    const results = await runAll(fixtures);
    const people = results.find((r) => r.capability === "professional-people-search")!;
    // delivered: p_1 (both fields), p_2 (email), p_3 (phone), p_4 (none), p_6 (empty strings), p_8 (email); p_5 duplicate, p_7 other country
    expect(people.delivered).toBe(6);
    expect(people.duplicates).toBe(1);
    expect(people.people).toMatchObject({ baseUnits: 4, emailUnits: 3, phoneUnits: 2, notChargedRows: 2 });
    // 4 x 83 + 3 x 55 + 2 x 55 = 607, capped at the job maximum of 600
    expect(people.people!.chargePoints).toBe(600);
  });

  it("the committed docs/EXTRACTION_BENCHMARK.md is the current output (re-run the script and commit when fixtures or rules change)", async () => {
    const results = await runAll(fixtures);
    const committed = readFileSync(path.resolve(__dirname, "../docs/EXTRACTION_BENCHMARK.md"), "utf8");
    expect(committed).toBe(renderBenchmarkMarkdown(results, baseline));
  });
});
