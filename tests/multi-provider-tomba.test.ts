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
});
