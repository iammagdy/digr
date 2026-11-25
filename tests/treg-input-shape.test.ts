import { describe, expect, it } from "vitest";
import { validateInputShape } from "../src/lib/treg/inputShape";
import { validateInputShape as reExportedFromTools } from "../agent/src/tools";
import type { CatalogEndpoint } from "../src/lib/treg/catalog";

const fakeEndpoint = {
  id: "generic.search",
  inputs: [
    { name: "keywords", in: "body", type: "array[string]", required: true, enum: null, minimum: null, maximum: null, default: null, example: ["solar"], note: null },
    {
      name: "filter",
      in: "body",
      type: "object",
      required: false,
      enum: null,
      minimum: null,
      maximum: null,
      default: null,
      example: null,
      note: null,
      fields: {
        locations: { type: "array[string]", required: false, description: "cities", example: ["Cairo"] },
      },
    },
  ],
} as unknown as CatalogEndpoint;

describe("validateInputShape pure catalog input schema validator", () => {
  it("is re-exported identically from agent/src/tools.ts", () => {
    expect(reExportedFromTools).toBe(validateInputShape);
  });

  it("accepts valid array and nested object array inputs (Must-Pass)", () => {
    expect(validateInputShape(fakeEndpoint, { keywords: ["solar"], filter: { locations: ["Cairo"] } })).toBeNull();
  });

  it("rejects non-array top-level array input and empty-string nested array[string] elements (Counter-Case)", () => {
    expect(validateInputShape(fakeEndpoint, { keywords: "solar" })).toContain('invalid input shape for «keywords»: expected array[string] (an array), got string');
    expect(validateInputShape(fakeEndpoint, { keywords: ["solar"], filter: { locations: "Cairo" } })).toContain('invalid input shape for «filter.locations»: expected array[string] (an array), got string');
    expect(validateInputShape(fakeEndpoint, { keywords: ["solar"], filter: { locations: [""] } })).toContain('expected array[string] (array of non-empty strings)');
  });
});
