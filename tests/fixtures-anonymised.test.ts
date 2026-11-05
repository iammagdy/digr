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

/**
 * STAGE 3, THE TWO RULES OF THE ANONYMISER PATCH. (1) An e-mail is an e-mail under ANY key (the SECRETS scan above looks at every string). (2) A URL under an ID-LIKE key must have been
 * anonymised: its host is a platform host or `host-<hex>.invalid` (a profile link on any other host, e.g. a LinkedIn member's, was kept as it was before the patch), and no path segment is a
 * readable name (a segment must carry a digit, be a placeholder, or be one of the generic words the anonymiser keeps).
 */
const ID_KEY = /(^|_)(id|ids|pk|uid|cid|mid|fbid)$|Id$|^id_str$|_id_str$|^sec_uid$|^aweme_id$|^feedback_id$|^comments_id$|^shares_id$|^rest_id$|^fbid_v2$/;
const PLATFORM_HOSTS = ["facebook.com", "fbcdn.net", "fb.watch", "instagram.com", "cdninstagram.com", "tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com", "byteoversea.com", "ibyteimg.com", "muscdn.com", "youtube.com", "youtu.be", "ytimg.com", "ggpht.com", "googleusercontent.com", "x.com", "twitter.com", "twimg.com", "t.co"];
const GENERIC_SEGMENTS = new Set(["posts", "videos", "video", "watch", "reel", "reels", "p", "status", "comment", "comments", "photo", "photo.php", "permalink.php", "story.php", "people", "pages", "profile.php", "share", "shorts", "channel", "playlist", "hashtag", "tv"]);
function idUrlRule(value: string): "id_url:host" | "id_url:segment" | null {
  if (!/^https?:\/\//i.test(value)) return null;
  let u: URL;
  try { u = new URL(value); } catch { return "id_url:host"; }
  const host = u.hostname.toLowerCase();
  const ok = /^host-[0-9a-f]+\.invalid$/.test(host) || PLATFORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) return "id_url:host";
  for (const seg of u.pathname.split("/").filter(Boolean)) if (!/\d/.test(seg) && !PLACEHOLDER.test(seg) && !GENERIC_SEGMENTS.has(seg.toLowerCase())) return "id_url:segment";
  return null;
}

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
  if (key !== null && ID_KEY.test(key)) { const r = idUrlRule(value); if (r) out.push({ file, path: at, rule: r }); }
  if (key !== null && PERSONAL.has(normKey(key))) {
    counted.personal += 1;
    if (value !== "" && !PLACEHOLDER.test(value)) out.push({ file, path: at, rule: `personal:${key}` });
  }
}

const files = jsonFiles(ROOT);

describe("anonymised real pages (decision 7.1): the scan that gates the public repo", () => {
  // CHANGED (live round 11): three more missions of the owner's admin ZIP (YouTube 19 files, Instagram 9, Facebook 5)
  // CHANGED (round 14): two more (Facebook msn_236f4af6fe4cb890abee 82 files, YouTube msn_5d5a9b2a933aeaa47d81 19 files)
  // CHANGED (round 20): one more (Facebook msn_934781c56a01a96825af, 11 files: the first real pages of the alternative comments card)
  // CHANGED (Stage 3): two more (the first real COMPANIES and DECISION-MAKERS pages: msn_4969a50fed8c45b37d8f 37 files, msn_7539ea17512cf58aa0e7 54 files), anonymised with the anonymise.py that has the two B2B rules
  it("holds the 39 missions (28 of FOUNDATION-PLAN PR 1, 2 of live round 7, 1 of live round 8, 3 of live round 11, 2 of round 14, 1 of round 20, 2 of Stage 3): 769 raw/ and rows/ files, nothing else", () => {
    expect(files.length).toBe(769);
    const rel = files.map((f) => path.relative(ROOT, f).split(path.sep));
    expect(new Set(rel.map((r) => r[0])).size).toBe(39);
    for (const r of rel) {
      expect(r[0]).toMatch(/^msn_[0-9a-f]{20}$/);
      expect(["raw", "rows"]).toContain(r[1]);
      expect(r.length).toBe(3);
    }
    expect(rel.filter((r) => r[1] === "raw").length).toBe(690); // CHANGED (Stage 3): 603 + 87
    expect(rel.filter((r) => r[1] === "rows").length).toBe(79); // CHANGED (Stage 3): 75 + 4
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

  it("the stored plan records of live missions (tests/fixtures/live/plans, passed through anonymise.py) pass the same scan", () => {
    const plans = jsonFiles(path.resolve(__dirname, "fixtures/live/plans"));
    expect(plans.map((f) => path.basename(f))).toEqual(["msn_24fd8dc0470a2c990cc0.json", "msn_b9eb261694fa611013d4.json", "msn_e32cd467fe6bbdfa943e.json"]);
    for (const f of plans) {
      const violations: Violation[] = [];
      scan(JSON.parse(readFileSync(f, "utf8")), null, "", path.basename(f), violations, { personal: 0 });
      expect(violations).toEqual([]);
    }
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

  // STAGE 3, the two rules of the anonymiser patch (the gap the first real company pages showed)
  it("the scanner catches an e-mail under a KEPT key and a URL under an id-like key that was left as it was (a profile link with a person's name)", () => {
    const hits = (v: unknown): string[] => { const o: Violation[] = []; scan(v, null, "", "probe", o, { personal: 0 }); return o.map((x) => x.rule); };
    // rule 1: an e-mail is an e-mail under any key, kept or not
    expect(hits({ id: "someone@example.test" })).toEqual(["email"]);
    expect(hits({ company_id: "note someone@example.test" })).toEqual(["email"]);
    // rule 2: a URL under an id-like key must be anonymised: its host is a platform host or `host-<hex>.invalid`, and no path segment is a readable name
    expect(hits({ employee_id: "https://www.linkedin.com/in/jane-doe" })).toEqual(["id_url:host"]);
    expect(hits({ rest_id: "https://www.facebook.com/jane.doe" })).toEqual(["id_url:segment"]);
    expect(hits({ id: "https://host-ab12cd.invalid/txt_ab12cd/12345" })).toEqual([]);
    expect(hits({ id: "https://www.facebook.com/txt_ab12cd/posts/123456" })).toEqual([]);
    // a URL under a key that is not id-like is not this rule's (the other scans and the anonymiser's URL rule cover it)
    expect(hits({ website: "https://example.test/about" })).toEqual([]);
  });
});
