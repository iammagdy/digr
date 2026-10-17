import { describe, it, expect } from "vitest";
import { getEnabledCapabilitiesWithCoreServices, UNAVAILABLE_CAPABILITY_SLUGS } from "../src/functions/shared/capabilityRegistry";

function registryWith(rows: any[]) {
  return {
    from: () => ({
      select: () => ({
        eq: async (column: string, value: unknown) => {
          if (column === "enabled") return { data: rows.filter((row) => row.enabled === value) };
          return { data: rows.filter((row) => row[column] === value) };
        },
      }),
    }),
  };
}

const TIKTOK = { slug: "tiktok-profile", enabled: true, unit_cost_usd: 0.001, unit_price_credits: 6, category: "tiktok" };

describe("core decision-maker service (owner decision D3)", () => {
  it("adds the reviewed people service while the registry has no row for it", async () => {
    const caps = await getEnabledCapabilitiesWithCoreServices(registryWith([TIKTOK]) as any);
    expect(caps.map((c) => c.slug)).toContain("professional-people-search");
  });

  it("respects an admin kill switch: a disabled registry row is never re-added", async () => {
    const caps = await getEnabledCapabilitiesWithCoreServices(
      registryWith([TIKTOK, { slug: "professional-people-search", enabled: false }]) as any,
    );
    expect(caps.map((c) => c.slug)).not.toContain("professional-people-search");
  });

  it("does not add the service when the registry cannot be read", async () => {
    const broken = {
      from: (table: string) => ({
        select: () => ({
          eq: async (column: string) => {
            if (column === "enabled") return { data: [TIKTOK] };
            throw new Error("registry unavailable");
          },
        }),
      }),
    };
    const caps = await getEnabledCapabilitiesWithCoreServices(broken as any);
    expect(caps.map((c) => c.slug)).not.toContain("professional-people-search");
  });

  it("keeps the unreliable legacy people endpoint blocked even if the registry enables it", async () => {
    expect(UNAVAILABLE_CAPABILITY_SLUGS.has("icypeas-people-search")).toBe(true);
    const caps = await getEnabledCapabilitiesWithCoreServices(
      registryWith([TIKTOK, { slug: "icypeas-people-search", enabled: true, unit_cost_usd: 0.00038, unit_price_credits: 3, category: "people" }]) as any,
    );
    expect(caps.map((c) => c.slug)).not.toContain("icypeas-people-search");
    expect(caps.map((c) => c.slug)).toContain("professional-people-search");
  });
});
