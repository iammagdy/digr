import { describe, expect, it } from "vitest";
import { REDACTED, assertNoSecrets, noCardReasonOf, paramKeysOf, redactError, redactFailure, redactText } from "../src/lib/server/adminMissionInspector";

/**
 * DT-20261118-06 PR 2: the redaction of the admin mission inspector. Table-driven: what must be masked, what must stay byte for byte (a count of tweets is not a phone number, a date is not a phone number), and the stricter rule for the free text of a failure
 * (BUG HUNTER Gate 1 P1-2: a short key echoed by a provider, a name or a path in an answer are REMOVED, not masked).
 */
describe("redactText: e-mails, phones, tokens, long runs and URL query strings are masked", () => {
  const masked: Array<[string, string]> = [
    ["e-mail", "اكتب إلى hossam.ali+x@orascom-em.com.eg الآن"],
    ["phone with country code", "اتصل على +20 100 123 4567 الآن"],
    ["phone in Arabic-Indic digits", "الرقم ٠١٠٠١٢٣٤٥٦٧ للتواصل"],
    ["phone with brackets and dashes", "tel (02) 2574-0001 ext"],
    ["bearer token", "failed with Authorization: Bearer abcDEF123456789xyz"],
    ["sk- key", "invalid key sk-live_abcdef123456"],
    ["jwt", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdef"],
    ["24+ hex", "id 0123456789abcdef0123456789abcdef"],
    ["32+ base64", "blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2"],
  ];
  for (const [name, text] of masked) it(`masks a ${name}`, () => { const r = redactText(text); expect(r).toContain(REDACTED); expect(r).not.toMatch(/orascom-em|123 4567|٠١٠٠١٢٣٤٥٦٧|2574-0001|abcDEF123456789|abcdef123456|eyJhbGci|0123456789abcdef|QUJDREVG/); });
  it("a URL keeps its path and loses its query string", () => {
    expect(redactText("GET https://api.example.com/v1/people?api_key=SECRET1&email=a@b.co failed")).toBe(`GET https://api.example.com/v1/people?${REDACTED} failed`);
  });
  const kept = ["٣٠٠ تغريدة عن محمد صلاح", "هات 300 تغريدة", "5 companies and 10 people", "2026-11-19T10:00:00.000Z", "حتى تاريخ 2026-11-19 تم", "2026-11-19 10:00:00", "حُجز ٢٥٦٩ نقطة وخُصم ٢٢٣٤", "rate limit exceeded (429)", "تم تسليم ٩ من ١٥", ""];
  for (const t of kept) it(`leaves «${t.slice(0, 30)}» byte for byte`, () => expect(redactText(t)).toBe(t));
  it("is cut at the limit and never throws on a non-string", () => {
    expect(redactText("ا".repeat(900), 600).length).toBe(601);
    expect(redactText(null)).toBe("");
    expect(redactText(12345)).toBe("12345");
  });
});

describe("redactFailure (Gate 1 P1-2): what carries a value is removed, the provider's wording of the category stays", () => {
  const cases: Array<[string, RegExp, RegExp]> = [
    ["Invalid API key 'abc123xyz'", /abc123xyz/, /Invalid API key/],
    ["x-api-key: abc123 was rejected", /abc123/, /rejected/],
    ["Authorization: tok_12ab34cd refused", /tok_12ab34cd/, /refused/],
    ["Invalid key 'johnsmith' rejected", /johnsmith/, /Invalid key rejected/],
    ["person john-doe not found", /john-doe/, /person not found/],
    ["company «شركة الأمل» not found for https://www.linkedin.com/company/alamal-co?x=1", /الأمل|linkedin|alamal/, /not found/],
    ["profile /in/hossam-ali-123456 missing", /hossam|123456/, /profile.*missing/],
    ["upstream 502 after 30000 ms for 1234567890", /30000|1234567890/, /upstream 502 after/],
    ["Lookup failed for Hossam Elgendy at Orascom", /Hossam|Elgendy|Orascom/, /^Lookup failed for at$/],
    ["Company not found: شركة الأمل للمقاولات", /الأمل|للمقاولات/, /^Company not found:$/],
    ["Invalid API key for the HTTP API", /^$/, /Invalid API key for the HTTP API/],
    ["rate limit exceeded", /^$/, /rate limit exceeded/],
  ];
  for (const [text, gone, stays] of cases) it(`«${text.slice(0, 40)}»`, () => { const r = redactFailure(text); expect(r).not.toMatch(gone); expect(r).toMatch(stays); });
  it("is cut at 200 characters", () => { expect(redactFailure("word ".repeat(100)).length).toBeLessThanOrEqual(201); });
});

describe("redactError keeps the structure of an admin error and cleans its detail", () => {
  it("the class and the reason stay; the detail is cleaned like a failure", () => {
    const r = redactError("admin: planning_failed class=internal reason=people_sources_failed detail=Invalid API key 'sk-abc123' for hossam@x.com");
    expect(r).toContain("class=internal reason=people_sources_failed");
    expect(r).not.toMatch(/sk-abc123|hossam@x\.com/);
    expect(noCardReasonOf(r)).toEqual({ cls: "internal", reason: "people_sources_failed" });
    expect(noCardReasonOf("something else")).toBeNull();
    expect(redactError("plain error 500")).toBe("plain error 500");
  });
});

describe("paramKeysOf: the names of the inputs only", () => {
  it("lists key names of a safe charset, sorted, never a value; internal keys (leading underscore) are left out", () => {
    expect(paramKeysOf({ query: "hossam@x.com", company_linkedin_url: "https://x", _failure: "boom", "bad key": 1, limit: 5 })).toEqual(["company_linkedin_url", "limit", "query"]);
    expect(paramKeysOf(null)).toEqual([]);
    expect(paramKeysOf(["a"])).toEqual([]);
  });
});

describe("assertNoSecrets: the last guard", () => {
  it("passes a clean response and throws on a string that still looks like a secret or a phone number", () => {
    expect(() => assertNoSecrets({ a: ["٣٠٠ تغريدة", { b: "2026-11-19T10:00:00.000Z" }] })).not.toThrow();
    for (const bad of ["a@b.co", "Bearer abcdef123456", "sk-abcdef123456", "0123456789abcdef0123456789abcdef", "+20 100 123 4567"]) expect(() => assertNoSecrets({ x: { y: [bad] } }), bad).toThrow(/inspector/);
  });
});
