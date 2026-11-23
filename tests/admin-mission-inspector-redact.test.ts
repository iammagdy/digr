import { describe, expect, it } from "vitest";
import {
  REDACTED,
  assertNoSecrets,
  buildInspection,
  cleanTrailingPunctuation,
  isSecretLeaf,
  noCardReasonOf,
  paramKeysOf,
  redactDeep,
  redactDeepString,
  redactError,
  redactFailure,
  redactJudgedText,
  redactJudgedUrl,
  redactText,
  redactUrlString,
  sanitizeLeaves,
} from "../src/lib/server/adminMissionInspector";

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

describe("planning failure reason projection", () => {
  const prefix = "admin: planning_failed class=internal reason=";

  it.each([3, 10, 99])("exposes the complete rejection count %i without a secret-shaped string", (count) => {
    const data = buildInspection({
      now: new Date("2026-11-19T10:00:00Z"), calls: [], events: [], callTotal: 0,
      mission: { id: "msn_fixture01", status: "failed", error: prefix + `plan_invalid_after_${count}_rejections` },
    });
    expect(data.planner.noCardReason).toEqual({ cls: "internal", reason: "plan_invalid", rejectionCount: count });
    expect(data.mission.error).toBe(prefix + `plan_invalid rejections=${count}`);
    expect(() => assertNoSecrets(data)).not.toThrow();
  });

  it.each([
    prefix + "plan_invalid_after_0_rejections",
    prefix + "plan_invalid_after_100_rejections",
    prefix + "plan_invalid_after_10_rejections_suffix",
    prefix + "unexpected_reason",
    "free text preceding " + prefix + "people_sources_failed",
  ])("ignores malformed or untrusted reason envelopes", (error) => {
    expect(noCardReasonOf(error)).toBeNull();
  });

  it("keeps a fixed reason and redacts its token, query string, private contacts and free-text values", () => {
    const error = prefix + "plan_invalid_after_10_rejections detail=" +
      "Invalid API key 'fixtureSecret123' for test.person@example.test at https://api.example.test/search?key=querySecret246 and +20 100 123 4567";
    const data = buildInspection({
      now: new Date("2026-11-19T10:00:00Z"), calls: [], events: [], callTotal: 0,
      mission: { id: "msn_fixture01", status: "failed", error },
    });
    expect(data.planner.noCardReason).toEqual({ cls: "internal", reason: "plan_invalid", rejectionCount: 10 });
    expect(data.mission.error).toContain("detail=Invalid API key");
    expect(JSON.stringify(data)).not.toMatch(/fixtureSecret123|querySecret246|test\.person|123 4567/);
    expect(() => assertNoSecrets(data)).not.toThrow();
  });

  it("uses only the fixed stop category and never echoes free text from no_plan or an unknown reason", () => {
    const error = prefix + "no_plan(error: fixture operator detail)";
    expect(noCardReasonOf(error)).toEqual({ cls: "internal", reason: "no_plan" });
    expect(redactError(error)).toBe(prefix + "no_plan");
    expect(redactError(prefix + "untrusted provider text")).toBe(prefix + REDACTED);
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

describe("redactJudgedUrl & redactJudgedText (DT-20261123 judgedRows redaction)", () => {
  it("redactJudgedUrl redacts numeric post IDs and base64 slugs while preserving domain and path structure", () => {
    expect(redactJudgedUrl("https://x.com/user/status/1859678493029485721")).toBe("https://x.com/user/status/[محجوب]");
    expect(redactJudgedUrl("https://news.example.com/articles/aHR0cHM6Ly9leGFtcGxlLmNvbS9zb21lL2xvbmcvc2x1Zy90aGF0L2lzLXZlcnktbG9uZw==")).toBe("https://news.example.com/articles/[محجوب]");
    expect(redactJudgedUrl("https://x.com/post/123")).toBe("https://x.com/post/123");
    expect(redactJudgedUrl("https://x.com/user/status/1859678493029485721?s=20")).toBe("https://x.com/user/status/[محجوب]?[محجوب]");
    expect(redactJudgedUrl(null)).toBeNull();
  });

  it("redactJudgedText masks phone/hex/b64 patterns but leaves emails unmasked so assertNoSecrets drops the row", () => {
    expect(redactJudgedText("تغريدة عن الاقتصاد المصري")).toBe("تغريدة عن الاقتصاد المصري");
    expect(redactJudgedText("تواصل هاتفيا 01001234567")).toBe("تواصل هاتفيا [محجوب]");
    expect(redactJudgedText("هاش 0123456789abcdef0123456789abcdef")).toBe("هاش [محجوب]");
    expect(redactJudgedText("معرف b64 QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2")).toBe("معرف b64 [محجوب]");
    // Emails remain unmasked so they trip assertNoSecrets
    expect(redactJudgedText("راسلنا عبر info@example.com")).toBe("راسلنا عبر info@example.com");
  });
});

describe("deep redaction: redactUrlString, redactDeepString, redactDeep & sanitizeLeaves (DT-20261124)", () => {
  it("cleanTrailingPunctuation separates sentence punctuation from URLs", () => {
    expect(cleanTrailingPunctuation("https://x.com/status/123.")).toEqual({ url: "https://x.com/status/123", suffix: "." });
    expect(cleanTrailingPunctuation("https://x.com/status/123).")).toEqual({ url: "https://x.com/status/123", suffix: ")." });
    expect(cleanTrailingPunctuation("https://x.com/status/123")).toEqual({ url: "https://x.com/status/123", suffix: "" });
  });

  it("redactUrlString masks long IDs, hex, and base64 runs while preserving host and path structure", () => {
    expect(redactUrlString("https://x.com/sample_author/status/1859678493029485721")).toBe("https://x.com/sample_author/status/[محجوب]");
    expect(redactUrlString("x.com/sample_author/status/1859678493029485721")).toBe("x.com/sample_author/status/[محجوب]");
    expect(redactUrlString("https://x.com/sample_author/status/1859678493029485721?ref=src&utm=123#frag")).toBe("https://x.com/sample_author/status/[محجوب]?[محجوب]#[محجوب]");
    expect(redactUrlString("https://news.example.com/item/aHR0cHM6Ly9leGFtcGxlLmNvbS9zb21lL2xvbmcvc2x1Zy90aGF0L2lzLXZlcnktbG9uZw==")).toBe("https://news.example.com/item/[محجوب]");
    expect(redactUrlString("not-a-url")).toBe("not-a-url");
  });

  it("redactDeepString handles sentences with embedded URLs, emails, tokens, and hashes", () => {
    const raw = "راجع المنشور https://x.com/author/status/1859678493029485721 أو راسل admin@diger.tech أو الرمز 0123456789abcdef0123456789abcdef";
    const cleaned = redactDeepString(raw);
    expect(cleaned).toContain("https://x.com/author/status/[محجوب]");
    expect(cleaned).toContain("[محجوب]");
    expect(cleaned).not.toContain("1859678493029485721");
    expect(cleaned).not.toContain("admin@diger.tech");
    expect(cleaned).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("redactDeep walks deep nested objects and arrays", () => {
    const payload = {
      stages: [
        {
          key: "stage_1",
          title_ar: "متابعة حساب x.com/user/status/1859678493029485721",
          items: ["0123456789abcdef0123456789abcdef", "normal text"],
        },
      ],
      details: {
        email: "test@example.com",
        phone: "+20 100 123 4567",
        count: 42,
        active: true,
      },
    };
    const redacted = redactDeep(payload);
    expect(redacted.stages[0].title_ar).toBe("متابعة حساب x.com/user/status/[محجوب]");
    expect(redacted.stages[0].items[0]).toBe("[محجوب]");
    expect(redacted.stages[0].items[1]).toBe("normal text");
    expect(redacted.details.email).toBe("[محجوب]");
    expect(redacted.details.phone).toBe("[محجوب]");
    expect(redacted.details.count).toBe(42);
    expect(redacted.details.active).toBe(true);
  });

  it("isSecretLeaf correctly tests for secrets and phone numbers", () => {
    expect(isSecretLeaf("test@example.com")).toBe(true);
    expect(isSecretLeaf("Bearer abcdef1234567890123456")).toBe(true);
    expect(isSecretLeaf("sk-abcdef1234567890")).toBe(true);
    expect(isSecretLeaf("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isSecretLeaf("+20 100 123 4567")).toBe(true);
    expect(isSecretLeaf("نص عادي سليم")).toBe(false);
    expect(isSecretLeaf("2026-11-24T12:00:00Z")).toBe(false);
  });

  it("sanitizeLeaves replaces offending leaves and logs paths", () => {
    const paths: string[] = [];
    const obj = {
      safe: "نص آمن",
      sub: {
        secret: "0123456789abcdef0123456789abcdef",
      },
      list: ["سليم", "user@corp.example"],
    };
    const sanitized = sanitizeLeaves(obj, "$", paths) as any;
    expect(sanitized.safe).toBe("نص آمن");
    expect(sanitized.sub.secret).toBe(REDACTED);
    expect(sanitized.list[0]).toBe("سليم");
    expect(sanitized.list[1]).toBe(REDACTED);
    expect(paths).toEqual(["$.sub.secret", "$.list[1]"]);
  });
});
