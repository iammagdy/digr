import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SEMANTIC_NOW_MS, understand, type Understood } from "./helpers/semanticUnderstand";

/**
 * PR-0.1, THE SEMANTIC UNDERSTANDING REGRESSION BASELINE (docs: Diger Intelligence Audit, 11 Nov 2026, chapter 16 brief #1). TESTS ONLY: no production file is touched, nothing here reaches a network, a model, a database or a flag.
 *
 * `tests/fixtures/semantic-paraphrases.json` holds ~100 requests in the customer's own words (Egyptian Arabic, typos, voice transcripts, Arabic mixed with English, paraphrases of one request, comments / replies, dates, countries, topics, routing,
 * chat pre-filters, privacy boundaries, multi-turn answers). Each case states, by hand, what the request MEANS (`expected`: only the fields that matter for that case). The suite runs the existing PURE functions over each text and compares.
 *
 * KNOWN GAPS ARE NOT HIDDEN AND NOT WEAKENED. A case where today's code does not understand the request carries `known_gap: { ref, why, observed }`, and gets TWO tests:
 *   1. «pins today» asserts the exact misunderstanding the code produces now (`observed`, only the fields that differ), so a CHANGE of behaviour in either direction turns the suite red;
 *   2. an `it.fails` asserts the CORRECT meaning (`expected`). It passes while the gap exists. The day a fix makes it true, `it.fails` turns RED: the fixing PR must then delete the `known_gap` block of that case (the case becomes an ordinary assertion).
 * An `expected` value is never edited to match the code: it is the correct reading. `observed` is what the code returns today, verified by running the functions (2026-11-11, main 001cbeb).
 */
interface Gap { ref: string; why: string; observed: Partial<Record<keyof Understood, unknown>> }
interface Case { id: string; group: string; text: string; answer?: string; source: string; expected: Partial<Record<keyof Understood, unknown>>; known_gap?: Gap; /** PR-1.4: a gap CLOSED in the real chat path; kept as history, and now an ordinary assertion */ closed_gap?: Gap & { closed_by: string } }
interface Fixture { now_iso: string; cases: Case[] }

const fixture = JSON.parse(readFileSync(new URL("./fixtures/semantic-paraphrases.json", import.meta.url), "utf8")) as Fixture;
const cases = fixture.cases;
const pick = (actual: Understood, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.map((k) => [k, actual[k as keyof Understood]]));
const run = (c: Case): Understood => understand(c.text, c.answer ?? null);

beforeAll(() => {
  // OFFLINE PROOF: any network use by a function under test fails the suite
  vi.stubGlobal("fetch", () => { throw new Error("network is forbidden in the semantic baseline"); });
});
afterAll(() => { vi.unstubAllGlobals(); });

describe("PR-0.1 the fixture itself", () => {
  it("has about 80 to 110 cases, unique ids, and every case states an expectation", () => {
    expect(cases.length).toBeGreaterThanOrEqual(80);
    expect(cases.length).toBeLessThanOrEqual(110);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(c.text.trim().length, c.id).toBeGreaterThan(0);
      expect(Object.keys(c.expected).length, c.id).toBeGreaterThan(0);
      expect(c.source.length, c.id).toBeGreaterThan(0);
    }
  });

  it("is counted from the SAME clock as the helper (relative dates count back from 2026-11-11 Cairo)", () => {
    expect(Date.parse(fixture.now_iso)).toBe(SEMANTIC_NOW_MS);
  });

  it("covers every required area of the brief", () => {
    const groups = new Set(cases.map((c) => c.group));
    for (const g of ["egyptian_paraphrase", "companies_b2b", "platform_spelling", "comments_replies_topic", "dates", "countries_language", "routing_sources", "prefilter_false_positive", "prefilter_guards_kept", "privacy_security", "multi_turn"]) expect(groups.has(g), g).toBe(true);
    const texts = cases.map((c) => c.text + " " + (c.answer ?? ""));
    // typos and spelling variants, voice transcripts, English / mixed Arabic-English, and a stray-space transcript
    expect(texts.some((t) => /تك توك/.test(t))).toBe(true);
    expect(texts.some((t) => /^[\x00-\x7F\s]+$/.test(t))).toBe(true);
    expect(texts.some((t) => /[A-Za-z]/.test(t) && /[ء-ي]/.test(t))).toBe(true);
    // the paraphrase sets of the audit (S-A, S-B) and the S-C pair that must NOT be equivalent
    expect(cases.filter((c) => c.id.startsWith("sa-")).length).toBeGreaterThanOrEqual(5);
    expect(cases.some((c) => c.id === "sb-01") && cases.some((c) => c.id === "sb-02") && cases.some((c) => c.id === "sb-03")).toBe(true);
    // multi-turn: card answers, typed answers, corrections
    expect(cases.filter((c) => c.answer !== undefined).length).toBeGreaterThanOrEqual(8);
  });

  const gaps = cases.filter((c) => c.known_gap);

  it("lists at least 20 known gaps, each with a reference, a reason and a pinned observation that really differs from the correct meaning", () => {
    expect(gaps.length).toBeGreaterThanOrEqual(20);
    for (const c of gaps) {
      const g = c.known_gap!;
      expect(g.ref.length, c.id).toBeGreaterThan(0);
      expect(g.why.length, c.id).toBeGreaterThan(10);
      const keys = Object.keys(g.observed);
      expect(keys.length, c.id).toBeGreaterThan(0);
      for (const k of keys) {
        expect(Object.keys(c.expected), `${c.id} observed field ${k} must be an expected field`).toContain(k);
        expect(JSON.stringify(g.observed[k as keyof Understood]), `${c.id}.${k} observed must differ from expected`).not.toBe(JSON.stringify(c.expected[k as keyof Understood]));
      }
    }
  });

  it("PR-1.4: the 7 pre-filter gaps closed in the real chat path keep their history (`closed_gap`), and are now ORDINARY assertions of the correct meaning", () => {
    const closed = cases.filter((c) => c.closed_gap);
    expect(closed.map((c) => c.id)).toEqual(["pf-01", "pf-02", "pf-03", "pf-04", "pf-05", "pf-08", "pf-09"]);
    for (const c of closed) {
      expect(c.known_gap, c.id).toBeUndefined();
      expect(c.closed_gap!.closed_by, c.id).toBe("PR-1.4");
      for (const k of Object.keys(c.closed_gap!.observed)) expect(JSON.stringify(c.closed_gap!.observed[k as keyof Understood]), `${c.id}.${k}: what was observed differs from the correct meaning`).not.toBe(JSON.stringify(c.expected[k as keyof Understood]));
      expect(pick(run(c), Object.keys(c.expected)), c.id).toEqual(c.expected);
    }
  });

  it("names every misunderstanding the audit listed (chapter 16 acceptance)", () => {
    // each entry: a word of the audit's list, and whether today's code gets it wrong (gap) or the audit's own sentence does NOT reproduce
    const AUDIT: Array<[string, "gap" | "not_reproduced"]> = [
      ["كومنتات", "gap"], ["comments", "gap"], ["تك توك", "gap"], ["انستاجرام", "gap"], ["Twitter", "gap"], ["فمصر", "gap"], ["اخر ٣ شهور", "gap"], ["السعوديه", "gap"],
      ["الخاصة بالسياحه", "gap"], ["عميل", "gap"], ["من انتخابات", "gap"], ["ChatGPT", "gap"], ["مكاتب شحن", "gap"], ["نصب الاستثمار", "gap"], ["حملات النصب", "not_reproduced"],
    ];
    for (const [word, status] of AUDIT) {
      const hit = cases.filter((c) => (c.text + " " + (c.answer ?? "")).includes(word));
      expect(hit.length, word).toBeGreaterThan(0);
      if (status === "gap") expect(hit.some((c) => c.known_gap || c.closed_gap), word).toBe(true);
      else expect(hit.every((c) => !c.known_gap), `${word}: the audit's own sentence is NOT reproduced by today's code`).toBe(true);
    }
  });

  it("asserts the privacy refusals of the audit as REFUSED where the code refuses them (the private-chat and national-id gaps S19 were closed by PR #447)", () => {
    const refused = cases.filter((c) => c.group === "privacy_security" && c.expected.prefilter === "privacy_refusal" && !c.known_gap);
    expect(refused.length).toBeGreaterThanOrEqual(4);
    // scenario #31 (phones of the people who commented) is refused today
    const s31 = cases.find((c) => c.id === "sc-01")!;
    expect(s31.known_gap).toBeUndefined();
    expect(run(s31).prefilter).toBe("privacy_refusal");
    // scenario #19 (private WhatsApp group messages) and the national id of a person were security gaps until PR #447; both are now ordinary refusals
    for (const id of ["sc-10", "sc-11"]) {
      const c = cases.find((x) => x.id === id)!;
      expect(c.known_gap, id).toBeUndefined();
      expect(run(c).prefilter, id).toBe("privacy_refusal");
    }
  });

  it("the legitimate guards still intercept AND the business-contact requests still go through (both directions of the privacy rule)", () => {
    for (const id of ["sc-08", "sc-09"]) expect(run(cases.find((c) => c.id === id)!).prefilter, id).toBe("agent");
    for (const id of ["sc-01", "sc-02", "sc-04", "sc-05"]) expect(run(cases.find((c) => c.id === id)!).prefilter, id).toBe("privacy_refusal");
  });
});

describe("PR-0.1 the understanding functions are pure and offline", () => {
  it("returns the same answer for the same words, every time, and never touches the network", () => {
    for (const c of cases) expect(run(c), c.id).toEqual(run(c));
  });
  it("is stable under extra whitespace in the request (the voice-transcript spacing case)", () => {
    const spaced = understand("  هات   تعليقات   تيك   توك   عن   السياحة  ");
    const plain = understand("هات تعليقات تيك توك عن السياحة");
    expect(spaced.platform).toBe(plain.platform);
    expect(spaced.comments).toBe(plain.comments);
    expect(spaced.topic).toBe(plain.topic);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE CASES, grouped. An ordinary case: today's code equals the correct meaning. A known gap: two tests (pin the misunderstanding; `it.fails` the correct meaning).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const byGroup = new Map<string, Case[]>();
for (const c of cases) byGroup.set(c.group, [...(byGroup.get(c.group) ?? []), c]);

for (const [group, list] of byGroup) {
  describe(`PR-0.1 ${group}`, () => {
    for (const c of list) {
      const label = `${c.id} «${c.text.trim()}»${c.answer !== undefined ? ` + answer «${c.answer}»` : ""}`;
      if (!c.known_gap) {
        it(label, () => {
          expect(pick(run(c), Object.keys(c.expected))).toEqual(c.expected);
        });
      } else {
        const gap = c.known_gap;
        it(`${label} PINS TODAY'S MISUNDERSTANDING [${gap.ref}] ${gap.why}`, () => {
          expect(pick(run(c), Object.keys(gap.observed))).toEqual(gap.observed);
        });
        // KNOWN GAP: this assertion of the CORRECT meaning fails today. When a fix makes it pass, `it.fails` goes red: remove this case's `known_gap` from the fixture.
        it.fails(`${label} KNOWN GAP [${gap.ref}]: the correct meaning`, () => {
          expect(pick(run(c), Object.keys(c.expected))).toEqual(c.expected);
        });
      }
    }
  });
}
