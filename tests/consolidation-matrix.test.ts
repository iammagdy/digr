import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { CONCERNED, RULES, SOCIAL_PLATFORMS, buildMatrix, matrixMarkdown } from "./helpers/ruleMatrix";

/**
 * THE RULE × PLATFORM × REQUEST TYPE TABLE of docs/S1-LIVE-FINDINGS.md («Consolidation»): every cell of every rule over every platform and every request type the rule concerns is either APPLIED (a test of this repository proves it: the cell names the test file and a fragment of the test's title, and this test checks both exist)
 * or NOT POSSIBLE (the catalog evidence is computed from the catalog snapshot, never typed by hand). The table in the document is generated from the same function and this test fails when the document and the code disagree (run with WRITE_MATRIX=1 to rewrite the document's table).
 */
const catalog = loadTregCatalog();
const matrix = buildMatrix(catalog);
const DOC = new URL("../docs/S1-LIVE-FINDINGS.md", import.meta.url);
const START = "<!-- consolidation-matrix:start -->";
const END = "<!-- consolidation-matrix:end -->";
const testFiles = new Map(readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".test.ts")).map((f) => [f, readFileSync(new URL(`./${f}`, import.meta.url), "utf8")] as const));

describe("every cell names a test that exists, and every not-possible cell carries computed catalog evidence", () => {
  it("every concerned cell (rule × platform × request type) is present, and is applied or not possible", () => {
    for (const rule of RULES) for (const p of SOCIAL_PLATFORMS) for (const t of CONCERNED[rule]) {
      const cell = matrix[rule][p][t];
      expect(cell, `${rule} ${p} ${t}`).toBeDefined();
      expect(["applied", "not_possible"]).toContain(cell!.status);
      expect(cell!.evidence.length, `${rule} ${p} ${t} evidence`).toBeGreaterThan(10);
    }
  });
  it("the test each cell names exists: the file is in tests/ and its text holds the fragment of the title", () => {
    for (const rule of RULES) for (const p of SOCIAL_PLATFORMS) for (const t of CONCERNED[rule]) {
      const [file, fragment] = matrix[rule][p][t]!.test.split("::");
      const text = testFiles.get(file);
      expect(text, `${rule} ${p} ${t}: ${file}`).toBeDefined();
      expect(text!.includes(fragment), `${rule} ${p} ${t}: «${fragment}» in ${file}`).toBe(true);
    }
  });
  it("the document's table is the generated one, with the counts", () => {
    const { markdown, applied, notPossible } = matrixMarkdown(matrix);
    const doc = readFileSync(DOC, "utf8");
    const summary = `${START}\n**الخلايا: ${applied + notPossible}؛ مطبَّقة: ${applied}؛ غير ممكنة (بدليل الكتالوج): ${notPossible}.**\n\n${markdown}\n${END}`;
    if (process.env.WRITE_MATRIX === "1") {
      const from = doc.indexOf(START);
      const to = doc.indexOf(END);
      expect(from).toBeGreaterThan(-1);
      writeFileSync(DOC, `${doc.slice(0, from)}${summary}${doc.slice(to + END.length)}`);
      return;
    }
    expect(doc.slice(doc.indexOf(START), doc.indexOf(END) + END.length)).toBe(summary);
  });
});
