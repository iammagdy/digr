import { describe, expect, it } from "vitest";
import dataPolicy from "../data/treg/data_policy.json";
import { replaceBareHostsInText, replaceUrlsInText } from "../src/lib/arabicNormalize";
import { withoutProviderHosts } from "../src/lib/agentMission/providerLabels";
import { DATA_PROVIDER_IDS, PROVIDER_ANTHROPIC, PROVIDER_CONTEXTDEV, PROVIDER_FIRECRAWL, PROVIDER_TREG } from "../src/lib/multiProvider/types";
import { PROVIDER_IDS } from "../src/lib/server/providerKeyCrypto";
import { PROVIDER_LABEL_AR } from "../src/lib/server/providerKeyAdmin";
import { tregBaseUrl } from "../src/lib/server/providerStatus";
import { KEY_COLUMN } from "../src/lib/server/callsLogExport";
import { PAUSED_PROVIDERS } from "../src/lib/treg/blockList";
import { adminCapabilityLabelAr, deriveJobLabelAr } from "../src/lib/server/adminJobLabels";
import { CHAIN_CAPABILITY_SLUG } from "../src/lib/multiProvider/routes";
import { readReverseLookupConfig } from "../src/lib/treg/reverseOrder";

/** PA2 (D-0232): the platform's own integration ids live in ONE identity file; every output below is the one 59dd75c8 produced (strings frozen here). */
describe("PA2 identity file: same ids, same brand text, same outputs", () => {
  it("the identity constants carry the ids exactly as stored in the database and the settings", () => {
    expect([PROVIDER_TREG, PROVIDER_FIRECRAWL, PROVIDER_CONTEXTDEV, PROVIDER_ANTHROPIC]).toEqual(["treg", "firecrawl", "contextdev", "anthropic"]);
    expect(DATA_PROVIDER_IDS).toEqual(["treg", "firecrawl", "contextdev"]);
    expect(PROVIDER_IDS).toEqual(["treg", "anthropic", "firecrawl", "contextdev"]);
  });

  it("admin labels are unchanged", () => {
    expect(PROVIDER_LABEL_AR).toEqual({
      treg: "مزود البيانات",
      anthropic: "مزود النموذج الذكي",
      firecrawl: "مزود قراءة المواقع (Firecrawl)",
      contextdev: "مزود البحث والقراءة (Context.dev)",
    });
    expect(KEY_COLUMN).toBe("المفتاح (TREG)");
    expect(adminCapabilityLabelAr(CHAIN_CAPABILITY_SLUG)).toBe("بيانات تواصل الشركات (عدة مزودين)");
    expect(adminCapabilityLabelAr("firecrawl.scrape")).toBe("قراءة صفحة (Firecrawl)");
  });

  it("job labels still drop the provider suffix (the suffix is OUR own text)", () => {
    expect(deriveJobLabelAr({ job: { template_slug: CHAIN_CAPABILITY_SLUG } })).toBe("بيانات تواصل الشركات");
    expect(deriveJobLabelAr({ job: { template_slug: "firecrawl.scrape" } })).toBe("قراءة صفحة");
  });

  it("the TREG base address and the paused providers are what they were", () => {
    expect(tregBaseUrl({} as any)).toBe("https://treg.to");
    expect(tregBaseUrl({ TREG_BASE_URL: "http://insecure.example" } as any)).toBe("https://treg.to");
    expect(tregBaseUrl({ TREG_BASE_URL: "https://other.example/" } as any)).toBe("https://other.example");
    expect([...PAUSED_PROVIDERS]).toEqual(["apollo", "datagma"]);
    expect([...PAUSED_PROVIDERS]).toEqual(dataPolicy.pausedProviders);
  });

  it("the reverse-lookup error still names the metadata key", () => {
    expect(() => readReverseLookupConfig({})).toThrow("provider-metadata.json: missing treg.reverseLookup");
  });

  it("address finders (module) stop at the Arabic comma and at a quote; text around is untouched", () => {
    expect(replaceUrlsInText("see https://a.example/x،then", (m) => `[${m}]`)).toBe("see [https://a.example/x]،then");
    expect(replaceBareHostsInText("open b.example/p now", (m) => `[${m}]`)).toBe("open [b.example/p] now");
    expect(replaceBareHostsInText("mail me@c.example", (m) => `[${m}]`)).toBe("mail me@c.example");
    expect(withoutProviderHosts("نص بدون رابط")).toBe("نص بدون رابط");
  });
});
