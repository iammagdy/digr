import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE PUBLIC REPO HOLDS ONLY ANONYMISED REAL PAGES (docs/FOUNDATION-PLAN.md decision 7.1).
 * `tests/fixtures/live/missions/<mission id>/(raw|rows)/*.json` are the 28 missions of FOUNDATION-PLAN PR 1, anonymised on the owner's device by
 * `tests/fixtures/live/anonymise.py` (whitelist rule). This scan is the gate before they may stay committed: it fails on a JWT, a "Bearer " header,
 * a cookie string, an e-mail address, and on any string in a personal field that is not a placeholder (نص_<hex> / txt_<hex>) or empty.
 * A failure is never fixed by hand: the owner re-runs the script and the scan starts again.
 */

const ROOT = path.resolve(__dirname, "fixtures/live/missions");
const PLACEHOLDER = /^(نص|txt)_[0-9a-f]+$/;
/** The personal fields of the owner's rule, compared without case, "_" and "-" (author_name, authorName, unique_id, nick_name …). */
const PERSONAL = new Set(["name", "authorname", "username", "handle", "uniqueid", "nickname", "text", "message", "caption", "title", "description", "bio", "place", "address"]);
const normKey = (k: string) => k.replace(/[_\-\s]/g, "").toLowerCase();
const SECRETS: Array<[string, RegExp]> = [
  ["jwt", /eyJ/],
  ["bearer", /Bearer /],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["cookie", /(set-cookie|cookie\s*[:=]|sessionid=|tt_chain_token=|sid_tt=|msToken=|ttwid=|odin_tt=)/i],
];

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsonFiles(p));
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

interface Violation { file: string; path: string; rule: string }

function scan(value: unknown, key: string | null, at: string, file: string, out: Violation[], counted: { personal: number }): void {
  if (Array.isArray(value)) { for (const v of value) scan(v, key, `${at}[]`, file, out, counted); return; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      for (const [rule, rx] of SECRETS) if (rx.test(k)) out.push({ file, path: `${at}.${k} (key)`, rule });
      scan(v, k, `${at}.${k}`, file, out, counted);
    }
    return;
  }
  if (typeof value !== "string") return;
  for (const [rule, rx] of SECRETS) if (rx.test(value)) out.push({ file, path: at, rule });
  if (key !== null && PERSONAL.has(normKey(key))) {
    counted.personal += 1;
    if (value !== "" && !PLACEHOLDER.test(value)) out.push({ file, path: at, rule: `personal:${key}` });
  }
}

const files = jsonFiles(ROOT);

describe("anonymised real pages (decision 7.1): the scan that gates the public repo", () => {
  it("holds the 28 missions of FOUNDATION-PLAN PR 1: 509 raw/ and rows/ files, nothing else", () => {
    expect(files.length).toBe(509);
    const rel = files.map((f) => path.relative(ROOT, f).split(path.sep));
    expect(new Set(rel.map((r) => r[0])).size).toBe(28);
    for (const r of rel) {
      expect(r[0]).toMatch(/^msn_[0-9a-f]{20}$/);
      expect(["raw", "rows"]).toContain(r[1]);
      expect(r.length).toBe(3);
    }
    expect(rel.filter((r) => r[1] === "raw").length).toBe(452);
    expect(rel.filter((r) => r[1] === "rows").length).toBe(57);
  });

  it("no JWT, no Bearer header, no cookie, no e-mail, and every personal field is a placeholder or empty", () => {
    const violations: Violation[] = [];
    const counted = { personal: 0 };
    for (const f of files) scan(JSON.parse(readFileSync(f, "utf8")), null, "", path.relative(ROOT, f), violations, counted);
    // the report names the file, the path and the rule, never the value
    expect(violations.slice(0, 20)).toEqual([]);
    expect(violations.length).toBe(0);
    expect(counted.personal).toBeGreaterThan(15000);
  });

  it("the script and its README sit beside the fixtures, and no ZIP is committed", () => {
    expect(existsSync(path.resolve(__dirname, "fixtures/live/anonymise.py"))).toBe(true);
    expect(existsSync(path.resolve(__dirname, "fixtures/live/README.md"))).toBe(true);
    const zips = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : n.toLowerCase().endsWith(".zip") ? [p] : []; });
    })(path.resolve(__dirname, "fixtures"));
    expect(zips).toEqual([]);
    const ignore = readFileSync(path.resolve(__dirname, "../.gitignore"), "utf8");
    expect(ignore).toMatch(/diger-fixtures-anon\*\.zip/);
  });

  it("the call index and the flags-off digests (PR 2a) pass the same scan, and every link in the index is reduced to its numeric id", () => {
    for (const name of ["fixtures/live/call-index.json", "fixtures/foundation-flags-off.json"]) {
      const p = path.resolve(__dirname, name);
      expect(existsSync(p), name).toBe(true);
      const violations: Violation[] = [];
      scan(JSON.parse(readFileSync(p, "utf8")), null, "", name, violations, { personal: 0 });
      expect(violations).toEqual([]);
    }
    const index = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/live/call-index.json"), "utf8")) as { missions: Record<string, Array<[string, string, string, string, number, Record<string, unknown>]>> };
    for (const calls of Object.values(index.missions)) for (const c of calls) for (const k of ["url", "post", "link"]) if (k in c[5]) expect(String(c[5][k])).toMatch(/^\d{15,}$/);
  });

  it("the scanner itself catches each rule (so a green run is not an empty run)", () => {
    const out: Violation[] = [];
    const c = { personal: 0 };
    scan({ a: { author_name: "Real Name", text: "نص_ab12", nickname: "", note: "eyJhbGciOi", h: "Bearer x", m: "a@b.co", ck: "sessionid=1", t: ["https://x.com/someone"] } }, null, "", "probe", out, c);
    expect(out.map((v) => v.rule).sort()).toEqual(["bearer", "cookie", "email", "jwt", "personal:author_name"].sort());
    const out2: Violation[] = [];
    scan({ text: "https://vt.tiktok.com/seg_ab/" , description: "نعم" }, null, "", "probe", out2, c);
    expect(out2.map((v) => v.rule).sort()).toEqual(["personal:description", "personal:text"]);
  });
});
