import { describe, expect, it } from "vitest";
import { getEnabledCapabilitiesWithCoreServices } from "../src/functions/shared/capabilityRegistry";
import { serviceRecordCeiling, validatePlanAgainstSchemas } from "../src/functions/shared/planManager";

/**
 * The plan-edit check uses a social service's own code ceiling, not a lower figure stored in its registry row, and never writes the registry.
 * The rows below are the stored rows read from production with SELECT only (slug, enabled, max_rows, pricing_unit, unit_price_credits).
 */
const STORED_ROWS = [
  { slug: "icypeas-companies-search", enabled: true, max_rows: 500, pricing_unit: "item", unit_price_credits: "3" },
  { slug: "professional-people-search", enabled: true, max_rows: 500, pricing_unit: "item", unit_price_credits: "83" },
  { slug: "social-facebook-comments", enabled: true, max_rows: 500, pricing_unit: "item", unit_price_credits: "11" },
  { slug: "social-facebook-posts", enabled: true, max_rows: 60, pricing_unit: "item", unit_price_credits: "11" },
  { slug: "social-tiktok-comments", enabled: true, max_rows: 1000, pricing_unit: "item", unit_price_credits: "6" },
  { slug: "social-tiktok-videos", enabled: true, max_rows: 200, pricing_unit: "item", unit_price_credits: "6" },
  { slug: "social-youtube-comments", enabled: true, max_rows: 1000, pricing_unit: "item", unit_price_credits: "9" },
  { slug: "social-youtube-videos", enabled: true, max_rows: 48, pricing_unit: "item", unit_price_credits: "5" },
];

/** A fake registry that serves the stored rows and records every call that is not a read. */
function fakeRegistry() {
  const writes: string[] = [];
  const rows = STORED_ROWS.map((row) => ({ ...row }));
  const chain: any = {
    select() { return chain; },
    eq() { return Promise.resolve({ data: rows, error: null }); },
    then(resolve: any) { resolve({ data: rows, error: null }); },
  };
  for (const method of ["insert", "update", "upsert", "delete"]) chain[method] = (...args: unknown[]) => { writes.push(`${method}(${JSON.stringify(args).slice(0, 80)})`); return chain; };
  const tables: any = {
    from: () => chain,
    rpc: (name: string) => { writes.push(`rpc(${name})`); return Promise.resolve({ data: null, error: null }); },
    createRow: () => { writes.push("createRow"); },
    updateRow: () => { writes.push("updateRow"); },
    deleteRow: () => { writes.push("deleteRow"); },
  };
  return { tables, writes, rows };
}

const item = (slug: string, volume: number) => ({
  capabilitySlug: slug, params: { query: "x", url: "https://www.youtube.com/watch?v=abc" }, targetVolumeMin: 1, targetVolumeMax: volume, unitCostUsd: 0.001,
}) as any;

describe("the plan-edit check uses the code ceiling over a lower stored registry value, and writes nothing", () => {
  it("a 1,897-comment edit is accepted for YouTube and TikTok comments although the stored rows say 1,000", async () => {
    const { tables, writes, rows } = fakeRegistry();
    const caps = await getEnabledCapabilitiesWithCoreServices(tables);
    // the live list still carries the stored figure ...
    expect((caps.find((c: any) => c.slug === "social-youtube-comments") as any).maxRows).toBe(1000);
    expect((caps.find((c: any) => c.slug === "social-tiktok-comments") as any).maxRows).toBe(1000);
    // ... and the check no longer refuses an edit up to the code ceiling
    for (const slug of ["social-youtube-comments", "social-tiktok-comments"]) {
      expect(validatePlanAgainstSchemas([item(slug, 1897)], caps as any)).toEqual({ valid: true, errors: [] });
      expect(validatePlanAgainstSchemas([item(slug, 2000)], caps as any).valid).toBe(true);
    }
    // the registry was only read, and the stored rows are unchanged
    expect(writes).toEqual([]);
    expect(rows).toEqual(STORED_ROWS);
  });

  it("above the code ceiling an edit is still refused, with the code ceiling in the message", async () => {
    const { tables } = fakeRegistry();
    const caps = await getEnabledCapabilitiesWithCoreServices(tables);
    const refused = validatePlanAgainstSchemas([item("social-youtube-comments", 2001)], caps as any);
    expect(refused.valid).toBe(false);
    expect(refused.errors.join(" ")).toContain("(2000)");
    expect(validatePlanAgainstSchemas([item("social-tiktok-comments", 2001)], caps as any).valid).toBe(false);
  });

  it("X posts have no stored row and keep their code ceiling; services whose row equals the code ceiling are unchanged", async () => {
    const { tables, writes } = fakeRegistry();
    const caps = await getEnabledCapabilitiesWithCoreServices(tables);
    expect(validatePlanAgainstSchemas([item("social-x-posts", 4453)], caps as any).valid).toBe(true);
    expect(validatePlanAgainstSchemas([item("social-x-posts", 4501)], caps as any).valid).toBe(false);
    expect(validatePlanAgainstSchemas([item("social-facebook-posts", 61)], caps as any).valid).toBe(false);
    expect(validatePlanAgainstSchemas([item("social-facebook-posts", 60)], caps as any).valid).toBe(true);
    expect(validatePlanAgainstSchemas([item("social-facebook-comments", 501)], caps as any).valid).toBe(false);
    expect(writes).toEqual([]);
  });

  it("the ceiling function: a social service takes the larger of its stored row and its code ceiling; any other service keeps the stored row", () => {
    expect(serviceRecordCeiling("social-youtube-comments", 1000)).toBe(2000);
    expect(serviceRecordCeiling("social-tiktok-comments", 1000)).toBe(2000);
    expect(serviceRecordCeiling("social-youtube-comments", 5000)).toBe(5000); // a higher stored row is never lowered
    expect(serviceRecordCeiling("social-x-posts", undefined)).toBe(4500);
    expect(serviceRecordCeiling("icypeas-companies-search", 500)).toBe(500);
    expect(serviceRecordCeiling("some-other-service", 123)).toBe(123);
  });
});
