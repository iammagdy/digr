import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { UNDERSTAND_SCHEMA } from "../agent/src/llmPlanner/prompts";
import { researchRelevanceOf } from "../src/lib/agentMission/foundation/compilePlan";

export function countSchemaProperties(schema: unknown): { total: number; optional: number } {
  let total = 0;
  let optional = 0;
  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      const required = new Set(Array.isArray(obj.required) ? obj.required : []);
      for (const [key, prop] of Object.entries(obj.properties as Record<string, unknown>)) {
        total++;
        if (!required.has(key)) optional++;
        walk(prop);
      }
    }
    if (obj.type === "array" && obj.items) {
      walk(obj.items);
    }
  }
  walk(schema);
  return { total, optional };
}

describe("P0 hotfix: planner output schema complexity guard against 474a8f5f", () => {
  it("planner output schema optional-property count and total property count are <= 474a8f5f baseline fixture", () => {
    const fixturePath = path.resolve(__dirname, "fixtures/planner-schema-474a8f5f.json");
    const baselineSchema = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const baseline = countSchemaProperties(baselineSchema);
    const current = countSchemaProperties(UNDERSTAND_SCHEMA);

    // Baseline at 474a8f5f has total: 39, optional: 15
    expect(current.optional).toBeLessThanOrEqual(baseline.optional);
    expect(current.total).toBeLessThanOrEqual(baseline.total);

    // Specifically guard against optional 'entity' property in step schema
    const stepProps = (UNDERSTAND_SCHEMA as any)?.properties?.steps?.items?.properties;
    expect(stepProps?.entity).toBeUndefined();
  });

  it("criterion building works with no entity field in planner step output", () => {
    // 1. With named non-URL source: entity falls back to source value
    const askNamedSource = {
      topic: { text: "بيانات رسمية", relation: "about" as const, alternatives: ["بيان"] },
      source: { kind: "official" as const, text: "Mohgovsa" },
      country: "SA",
      brief: "متابعة الحساب الرسمي",
    };
    const relevanceNamed = researchRelevanceOf(askNamedSource, ["title", "text"]);
    expect(relevanceNamed?.criterion.entity).toBe("Mohgovsa");
    expect(relevanceNamed?.criterion.country).toBe("SA");
    expect(relevanceNamed?.criterion.topic).toBe("بيانات رسمية");
    expect(relevanceNamed?.criterion.brief).toBe("متابعة الحساب الرسمي");

    // 2. With URL source: entity falls back to empty string
    const askUrlSource = {
      topic: { text: "أخبار التقنية", relation: "about" as const, alternatives: ["تكنولوجيا"] },
      source: { kind: "named" as const, text: "https://example.com/feed" },
      country: "EG",
      brief: "متابعة موجز التقنية",
    };
    const relevanceUrl = researchRelevanceOf(askUrlSource, ["title", "text"]);
    expect(relevanceUrl?.criterion.entity).toBe("");
    expect(relevanceUrl?.criterion.country).toBe("EG");

    // 3. With no source at all: entity falls back to empty string (no hardcoded words, no defaults)
    const askNoSource = {
      topic: { text: "أسعار العملات", relation: "about" as const, alternatives: ["سعر الصرف"] },
      country: "EG",
      brief: "متابعة أسعار العملات",
    };
    const relevanceNone = researchRelevanceOf(askNoSource, ["title", "text"]);
    expect(relevanceNone?.criterion.entity).toBe("");
    expect(relevanceNone?.criterion.country).toBe("EG");
    expect(relevanceNone?.criterion.topic).toBe("أسعار العملات");
  });
});
