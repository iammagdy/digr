import { describe, expect, it } from "vitest";
import { foldArabicComma } from "../src/lib/arabicNormalize";
import { typedConfirmMatches } from "../src/components/admin/ConfirmDialog";
import { parseProvidersQuery, providersQuery, PROVIDER_TAB_IDS } from "../src/components/admin/providerViews";

/** PA1 (D-0232): admin screens read the provider ids from the identity file; every behaviour below is the one 59dd75c8 had. */
describe("PA1 admin screens: same behaviour with the identity constants", () => {
  it("the typed confirmation ignores digit shapes, blanks and group separators (comparison only)", () => {
    expect(typedConfirmMatches("١٬٥٠٠", "1500")).toBe(true);
    expect(typedConfirmMatches("1 500", "١٥٠٠")).toBe(true);
    expect(typedConfirmMatches("1,500", "1500")).toBe(true);
    expect(typedConfirmMatches("1500", "1501")).toBe(false);
    expect(typedConfirmMatches("anything", undefined)).toBe(true);
  });

  it("the Arabic decimal mark now compares equal to the dot (documented widening: comparison key, never shown)", () => {
    expect(typedConfirmMatches("١٢٫٥", "12.5")).toBe(true);
    expect(typedConfirmMatches("1٫500", "1500")).toBe(false);
    expect(typedConfirmMatches("125", "12.5")).toBe(false);
  });

  it("the provider tabs keep their ids, their order and their query strings", () => {
    expect(PROVIDER_TAB_IDS).toEqual(["treg", "firecrawl", "contextdev", "anthropic"]);
    expect(parseProvidersQuery("")).toEqual({ tab: "treg", view: "status" });
    expect(parseProvidersQuery("?p=firecrawl&v=keys")).toEqual({ tab: "firecrawl", view: "keys" });
    expect(parseProvidersQuery("?p=unknown")).toEqual({ tab: "treg", view: "status" });
    expect(providersQuery("treg", "status")).toBe("");
    expect(providersQuery("firecrawl", "limits")).toBe("?p=firecrawl&v=limits");
  });

  it("a list of ids typed with the Arabic comma splits like the ASCII comma (raw-pages box)", () => {
    const split = (raw: string) => foldArabicComma(raw).split(/[\s,]+/).filter((t) => t.length > 0).join(",");
    expect(split("msn_a، msn_b\nmsn_c")).toBe("msn_a,msn_b,msn_c");
    expect(split("msn_a,msn_b")).toBe("msn_a,msn_b");
  });
});
