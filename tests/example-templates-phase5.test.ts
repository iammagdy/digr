import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  buildReadyExampleTemplates,
  EXAMPLE_TEMPLATES_HEADING_AR,
  EXAMPLE_PRICE_DISCLAIMER_AR,
} from "../src/functions/shared/exampleTemplates";
import { buildApprovedCatalog } from "../src/functions/shared/capabilityRegistry";

describe("Phase 5: Ready-to-Use Example Templates on Landing & Chat", () => {
  it("builds ready-to-use example templates with description, deliverables, editable prompt, and exact disclaimer", () => {
    expect(EXAMPLE_TEMPLATES_HEADING_AR).toBe("أمثلة جاهزة");
    expect(EXAMPLE_PRICE_DISCLAIMER_AR).toBe("السعر تقريبي ويُحسب نهائيًا بعد الموافقة على الخطة");

    const templates = buildReadyExampleTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(4);

    for (const tpl of templates) {
      expect(tpl.id).toBeTruthy();
      expect(tpl.titleAr).toBeTruthy();
      expect(tpl.shortDescriptionAr).toBeTruthy();
      expect(tpl.deliverablesAr).toBeTruthy();
      expect(tpl.editablePromptAr).toBeTruthy();
      expect(tpl.approximatePoints).toBeGreaterThan(0);
      expect(tpl.disclaimerAr).toBe("السعر تقريبي ويُحسب نهائيًا بعد الموافقة على الخطة");
    }
  });

  it("computes approximatePoints dynamically from the capability registry (never hardcoded by hand)", () => {
    const defaultCatalog = new Map(buildApprovedCatalog().map((c) => [c.id, c]));
    const defaultTemplates = buildReadyExampleTemplates();

    for (const tpl of defaultTemplates) {
      const expectedPoints = tpl.steps.reduce((sum, step) => {
        const cap = defaultCatalog.get(step.capabilityId)!;
        return sum + (cap.pointsPerUnit || 0) * step.estimatedUnits;
      }, 0);
      expect(tpl.approximatePoints).toBe(expectedPoints);
    }

    // Changing registry settings dynamically updates template prices without touching template definitions
    const customTemplates = buildReadyExampleTemplates({
      usdToEgp: 60,
      markup: 12,
      pointValueEgp: 0.10,
      minimumOrderPoints: 50,
    });
    expect(customTemplates[0].approximatePoints).toBeGreaterThan(defaultTemplates[0].approximatePoints);
  });

  it("the V7 design replaces the priced example cards with three fixed starters (no invented prices in the UI)", () => {
    const empty = readFileSync("src/app/dashboard/chat/components/EmptyChat.tsx", "utf-8");
    const chatSource = readFileSync("src/app/dashboard/chat/page.tsx", "utf-8");
    expect(empty).toContain("حساب عام على تيك توك");
    expect(chatSource).not.toContain("تقريبيًا");
  });
});
