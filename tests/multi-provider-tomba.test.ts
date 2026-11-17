/**
 * ALL fixtures in this file are SYNTHETIC (built from the catalog's trimmed example plus
 * ASSUMED element fields) and prove only the reader's fail-closed behaviour, NOT that Tomba
 * returns these fields.
 */

import { describe, expect, it } from "vitest";
import { readTombaMailbox, tombaAnswerKind } from "../src/lib/multiProvider/tregContacts";

function makeSyntheticFixture(domain: string, emailOverrides: Record<string, any> = {}) {
  return {
    meta: {
      params: { domain },
      total: 1,
    },
    data: {
      organization: {
        disposable: false,
        webmail: false,
        accept_all: false,
      },
      emails: [
        {
          email: `info@${domain}`,
          type: "generic",
          verification: { status: "valid" },
          ...emailOverrides,
        },
      ],
    },
  };
}

describe("T-E readTombaMailbox (synthetic fixtures)", () => {
  it("T-E accepted: valid role mailbox with generic type and valid verification is accepted", () => {
    const fixture = makeSyntheticFixture("example.com");
    const result = readTombaMailbox(fixture, "example.com");
    expect(result).toEqual({
      value: "info@example.com",
      status: "verified",
      evidence: "provider_listed",
    });
  });

  it("T-E status cases: missing, unknown, or invalid verification status results in MISS", () => {
    // Missing verification.status
    const missingStatus = makeSyntheticFixture("example.com", { verification: {} });
    expect(readTombaMailbox(missingStatus, "example.com")).toBeNull();

    const noVerification = makeSyntheticFixture("example.com", { verification: undefined });
    expect(readTombaMailbox(noVerification, "example.com")).toBeNull();

    // verification.status === "unknown"
    const unknownStatus = makeSyntheticFixture("example.com", { verification: { status: "unknown" } });
    expect(readTombaMailbox(unknownStatus, "example.com")).toBeNull();

    // verification.status === "invalid"
    const invalidStatus = makeSyntheticFixture("example.com", { verification: { status: "invalid" } });
    expect(readTombaMailbox(invalidStatus, "example.com")).toBeNull();
  });
it("T-E address rules: personal address, subdomains, other domain, personal domain, placeholder, masked, domain mismatch, and org flags result in MISS", () => {
    const domain = "example.com";

    // 1. Person's address (not generic type, not role mailbox)
    const person = makeSyntheticFixture(domain, { email: `john.doe@${domain}`, type: "personal" });
    expect(readTombaMailbox(person, domain)).toBeNull();

    // 2. Subdomain
    const subdomain = makeSyntheticFixture(domain, { email: `info@sub.${domain}` });
    expect(readTombaMailbox(subdomain, domain)).toBeNull();

    // 3. Another domain
    const anotherDomain = makeSyntheticFixture(domain, { email: "info@anotherdomain.com" });
    expect(readTombaMailbox(anotherDomain, domain)).toBeNull();

    // 4. Personal domain
    const personalDomain = makeSyntheticFixture("gmail.com", { email: "info@gmail.com" });
    expect(readTombaMailbox(personalDomain, "gmail.com")).toBeNull();

    // 5. Placeholder address
    const placeholder = makeSyntheticFixture(domain, { email: `email@${domain}` });
    expect(readTombaMailbox(placeholder, domain)).toBeNull();

    // 6. Masked * address
    const masked = makeSyntheticFixture(domain, { email: `in*o@${domain}` });
    expect(readTombaMailbox(masked, domain)).toBeNull();

    // 7. meta.params.domain different
    const diffDomainFixture = makeSyntheticFixture("otherdomain.com");
    expect(readTombaMailbox(diffDomainFixture, domain)).toBeNull();

    // 8. accept_all true => MISS
    const acceptAll = makeSyntheticFixture(domain);
    acceptAll.data.organization.accept_all = true;
    expect(readTombaMailbox(acceptAll, domain)).toBeNull();

    // 9. webmail true => MISS
    const webmail = makeSyntheticFixture(domain);
    webmail.data.organization.webmail = true;
    expect(readTombaMailbox(webmail, domain)).toBeNull();

    // 10. disposable true => MISS
    const disposable = makeSyntheticFixture(domain);
    disposable.data.organization.disposable = true;
    expect(readTombaMailbox(disposable, domain)).toBeNull();
  });
it("T-E malformed shapes: invalid data types, large lists, prototype pollution, hidden fields and error bodies result in MISS", () => {
    const domain = "example.com";

    // 1. data.emails not an array
    const notArray = makeSyntheticFixture(domain);
    (notArray.data as any).emails = "not an array";
    expect(readTombaMailbox(notArray, domain)).toBeNull();

    // 2. elements not objects
    const notObjects = makeSyntheticFixture(domain);
    notObjects.data.emails = ["string_element", null, 12345] as any;
    expect(readTombaMailbox(notObjects, domain)).toBeNull();

    // 3. email not a string
    const emailNotString = makeSyntheticFixture(domain);
    (emailNotString.data.emails[0] as any).email = 12345;
    expect(readTombaMailbox(emailNotString, domain)).toBeNull();

    // 4. 5,000 elements
    const largeList = makeSyntheticFixture(domain);
    largeList.data.emails = Array.from({ length: 5000 }, (_, i) => ({
      email: `other_${i}@${domain}`,
      type: "personal",
      verification: { status: "invalid" },
    }));
    expect(readTombaMailbox(largeList, domain)).toBeNull();

    // 5. Prototype-pollution keys (__proto__, constructor)
    const jsonWithPollution = `{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"meta":{"params":{"domain":"${domain}"},"total":0},"data":{"organization":{"disposable":false,"webmail":false,"accept_all":false},"emails":[]}}`;
    const parsedPollution = JSON.parse(jsonWithPollution);
    expect(readTombaMailbox(parsedPollution, domain)).toBeNull();
    expect((Object.prototype as any).polluted).toBeUndefined();

    // 6. E-mail addresses hidden in other fields (description, sources, organization) are NOT read
    const hiddenInFields = makeSyntheticFixture(domain);
    hiddenInFields.data.emails = [];
    (hiddenInFields.data as any).description = `Contact support at info@${domain}`;
    (hiddenInFields.data as any).sources = [`https://${domain}/contact/info@${domain}`];
    (hiddenInFields.data.organization as any).email = `info@${domain}`;
    expect(readTombaMailbox(hiddenInFields, domain)).toBeNull();

    // 7. Malformed JSON and HTTP 200 with an error body => MISS (plus tombaAnswerKind checks)
    expect(readTombaMailbox(null, domain)).toBeNull();
    expect(readTombaMailbox("not json string", domain)).toBeNull();
    expect(readTombaMailbox({ error: "rate_limit_exceeded" }, domain)).toBeNull();

    expect(tombaAnswerKind(null)).toBe("unparsable");
    expect(tombaAnswerKind("malformed")).toBe("unparsable");
    expect(tombaAnswerKind({ error: "bad_request" })).toBe("unparsable");
    expect(tombaAnswerKind({ data: { emails: [] }, meta: { total: 0 } })).toBe("empty");
    expect(tombaAnswerKind({ data: { emails: [{ email: `info@${domain}` }] }, meta: { total: 1 } })).toBe("non_empty");
  });
});
