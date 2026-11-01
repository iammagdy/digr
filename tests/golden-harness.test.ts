import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BENCHMARKS, GOLDEN_PROMPTS, checkShape, renderReport, sourceStatus, type Delivery } from "./helpers/goldenWorld";
import { loadTregCatalog, parseCatalog } from "../src/lib/treg/catalog";

/** S1 item 0.2: the golden and benchmark harness. It checks a delivery (what the customer's file holds) against the shape of docs/AUDIT-2026-11.md section 7 and docs/benchmarks/antigravity-10.md. */
const g3 = (): Delivery => ({
  approvedCount: 2, deliveredCount: 2, shortfallReasonAr: null, chargedPoints: 2,
  sheets: { posts: { headers: ["الحساب", "نص التغريدة", "التاريخ والوقت", "رابط التغريدة", "الإعجابات"], rows: [{ "الحساب": "@a", "نص التغريدة": "نص", "التاريخ والوقت": "2026-10-30", "رابط التغريدة": "https://x.example/1", "الإعجابات": "٣" }, { "الحساب": "@b", "نص التغريدة": "نص آخر", "التاريخ والوقت": "2026-10-31", "رابط التغريدة": "https://x.example/2", "الإعجابات": "٥" }] } },
  customerTexts: ["تم تسليم ٢ من ٢ تغريدة."],
});

describe("the harness knows the sets it checks", () => {
  it("six golden prompts and ten benchmark requests, in the order of the owner's file", () => {
    expect(GOLDEN_PROMPTS.map((g) => g.id)).toEqual(["G1", "G2", "G3", "G4", "G5", "G6"]);
    expect(BENCHMARKS.map((b) => b.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const md = readFileSync("docs/benchmarks/antigravity-10.md", "utf-8");
    const headings = [...md.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(headings).toEqual(BENCHMARKS.map((b) => b.id));
    for (const b of BENCHMARKS) expect(md).toContain(b.requestAr);
  });
});

describe("the shape checks", () => {
  const g3shape = GOLDEN_PROMPTS.find((g) => g.id === "G3")!;
  it("a delivery with every required column and the approved count passes", () => {
    expect(checkShape(g3(), g3shape.expect)).toEqual([]);
  });
  it("FAILS when a sheet lacks a required column", () => {
    const d = g3();
    d.sheets.posts.headers = d.sheets.posts.headers.filter((h) => h !== "رابط التغريدة");
    expect(checkShape(d, g3shape.expect).join(" ")).toContain("رابط التغريدة");
  });
  it("FAILS when the delivered count differs from the approved count without the truthful reason", () => {
    const d = g3(); d.deliveredCount = 1;
    expect(checkShape(d, g3shape.expect).join(" ")).toContain("delivered 1 of 2");
    d.shortfallReasonAr = "لم يعطِ المصدر أكثر من ذلك.";
    expect(checkShape(d, g3shape.expect)).toEqual([]);
  });
  it("FAILS on a provider name, a dollar amount, a Latin word or an emoji in customer text", () => {
    const d = g3(); d.customerTexts = ["سُلّم ٢ من ٢ عبر scrapecreators بتكلفة 0.5 USD 😀"];
    expect(checkShape(d, g3shape.expect).length).toBeGreaterThan(0);
  });
  it("FAILS when a comment has no parent link (an orphan)", () => {
    const d: Delivery = { ...g3(), sheets: { ...g3().sheets, comments: { headers: ["نص التعليق", "رابط الفيديو"], rows: [{ "نص التعليق": "ا", "رابط الفيديو": "" }] } } };
    expect(checkShape(d, { ...g3shape.expect, commentsSheet: { name: "comments", parentLinkHeader: "رابط الفيديو" } }).join(" ")).toContain("orphan");
  });
});

describe("a request with no source in the catalog is marked no_tool, never silently failed", () => {
  it("an empty catalog gives no_tool for the LinkedIn, Maps and papers requests", () => {
    const empty = parseCatalog({ endpoints: [] }, []);
    for (const id of [6, 7, 10]) expect(sourceStatus(BENCHMARKS.find((b) => b.id === id)!, empty)).toBe("no_tool");
  });
  it("the report lists every request with a status", () => {
    const text = renderReport(loadTregCatalog());
    for (const b of BENCHMARKS) expect(text).toContain(`#${b.id}`);
  });
});
