import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** ROUND 21, item 4: Python's bytecode cache (the fixture anonymiser is a Python script) is never committed. */
describe(".gitignore", () => {
  it("ignores __pycache__ folders and compiled Python files anywhere in the tree", () => {
    const lines = readFileSync(".gitignore", "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain("__pycache__/");
    expect(lines).toContain("*.pyc");
  });
});
