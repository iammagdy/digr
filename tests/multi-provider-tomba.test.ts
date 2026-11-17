/**
 * ALL fixtures in this file are SYNTHETIC (built from the catalog's trimmed example plus
 * ASSUMED element fields) and prove only the reader's fail-closed behaviour, NOT that Tomba
 * returns these fields.
 */

import { describe, expect, it } from "vitest";
import { readTombaMailbox } from "../src/lib/multiProvider/tregContacts";

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
});
