/**
 * Project Atlas documentation validation.
 *
 * Documentation-only guard: ensures every Atlas document exists and
 * carries its required top-level heading, that internal document/code
 * references resolve to real files, and that the agent bootstrap
 * protocol lists all 10 onboarding steps. No application code is
 * imported; no network or production access occurs.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const REQUIRED_DOCS: Array<[string, string]> = [
  ["Project Atlas/README.md", "# Project Atlas"],
  ["Project Atlas/MASTER_HANDBOOK.md", "# Digr Master Handbook"],
  ["Project Atlas/GOVERNANCE.md", "# Digr Governance"],
  ["Project Atlas/GLOSSARY.md", "# Digr Glossary"],
  ["Project Atlas/CURRENT_STATE.md", "# Digr Current State"],
  ["Project Atlas/WHERE_WE_STOPPED.md", "# Where We Stopped"],
  ["Project Atlas/ARCHITECTURE.md", "# Digr Architecture"],
  ["Project Atlas/PRODUCT.md", "# Digr Product"],
  ["Project Atlas/DECISIONS.md", "# Digr Decisions"],
  ["Project Atlas/CHANGELOG.md", "# Digr Changelog"],
  ["Project Atlas/skills/agent-bootstrap.md", "# Agent Bootstrap"],
  ["AGENTS.md", "# AGENTS.md"],
];

// Files whose backtick-quoted path references are checked for resolvability.
const SCANNED_DOCS = [...REQUIRED_DOCS.map(([rel]) => rel), "README.md"];

const DOC_EXTENSIONS = [".md", ".ts", ".tsx", ".json", ".mjs", ".css"];
const CODE_PREFIXES = ["src/", "scripts/", "tests/", "public/"];

function isCheckablePath(candidate: string): boolean {
  const c = candidate.trim();
  if (!c.includes("/")) return false;
  if (/^(https?:)?\/\//.test(c) || c.includes("://")) return false;
  // Exclude shell commands and env assignments, not paths.
  if (/[&|;$><*?'"`]/.test(c)) return false;
  if (DOC_EXTENSIONS.some((ext) => c.endsWith(ext))) return true;
  if (CODE_PREFIXES.some((p) => c.startsWith(p))) return true;
  return false;
}

function extractBacktickPaths(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const candidate = m[1].trim().replace(/[.,;:]+$/, "");
    if (isCheckablePath(candidate) && !out.includes(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

describe("Project Atlas documentation", () => {
  it("all required documents exist", () => {
    for (const [rel] of REQUIRED_DOCS) {
      expect(existsSync(join(ROOT, rel)), `missing: ${rel}`).toBe(true);
    }
  });

  it("each document carries its required heading", () => {
    for (const [rel, heading] of REQUIRED_DOCS) {
      const body = readFileSync(join(ROOT, rel), "utf-8");
      expect(body.includes(heading), `${rel} missing heading ${heading}`).toBe(
        true
      );
    }
  });

  it("internal document and code references resolve", () => {
    const broken: string[] = [];
    for (const rel of SCANNED_DOCS) {
      const body = readFileSync(join(ROOT, rel), "utf-8");
      for (const ref of extractBacktickPaths(body)) {
        const target = join(ROOT, ref);
        if (!existsSync(target)) {
          broken.push(`${rel} -> ${ref}`);
        }
      }
    }
    expect(broken, `broken references: ${broken.join("; ")}`).toEqual([]);
  });

  it("agent bootstrap defines the 10 onboarding steps", () => {
    const body = readFileSync(
      join(ROOT, "Project Atlas/skills/agent-bootstrap.md"),
      "utf-8"
    );
    expect(body.match(/^10\. /m), "bootstrap must list step 10").not.toBeNull();
  });

  it("root AGENTS.md directs agents to Project Atlas", () => {
    const body = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");
    expect(body.includes("Project Atlas")).toBe(true);
  });

  it("repository README references Project Atlas", () => {
    const body = readFileSync(join(ROOT, "README.md"), "utf-8");
    expect(body.includes("Project Atlas")).toBe(true);
  });
});
