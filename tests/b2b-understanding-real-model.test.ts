import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { understandRequest } from "../agent/src/llmPlanner/planner";
import { anthropicPlannerModel } from "../agent/src/llmPlanner/model";
import { handsOverToB2B, LLM_PLANNER_MODEL } from "../agent/src/llmPlanner/run";
import { loadTregCatalog } from "../src/lib/treg/catalog";

const FIXTURES_PATH = path.join(__dirname, "fixtures/b2b-real-requests.json");

describe("Phase 4 real-model B2B understanding (5/5)", () => {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const itLive = hasKey ? it : it.skip;

  itLive("runs 5/5 real-model understanding on production B2B requests with counter-cases", async () => {
    const data = JSON.parse(fs.readFileSync(FIXTURES_PATH, "utf8"));
    const modelName = process.env.LLM_PLANNER_MODEL || LLM_PLANNER_MODEL;
    const model = anthropicPlannerModel(process.env.ANTHROPIC_API_KEY!, modelName);
    const catalog = loadTregCatalog();

    for (let loop = 1; loop <= 5; loop++) {
      for (let i = 0; i < data.requests.length; i++) {
        const req = data.requests[i];
        const got = await understandRequest(
          { words: [req.text], request: req.text },
          { model, catalog, access: { isAdmin: false, verifiedBusiness: false }, today: "2026-11-25" }
        );
        expect(got.ok).toBe(true);
        if (!got.ok) continue;
        const u = got.value;

        // B2B handover assertion: true for requests 1-7, false for request 8 (companies only)
        if (i < 7) {
          expect(handsOverToB2B(u)).toBe(true);
          expect(u.people_of_companies?.asked).toBe(true);
        } else {
          expect(handsOverToB2B(u)).toBe(false);
          expect(u.people_of_companies?.asked ?? false).toBe(false);
        }

        // Baseline matching on explicit bound counts:
        // Case 2 (index 1): 5 companies, 4 per company
        if (i === 1) {
          expect(u.companies_count).toBe(5);
          expect(u.people_of_companies?.per_company).toBe(4);
        }
        // Case 3 (index 2): 1 per company
        if (i === 2) {
          expect(u.people_of_companies?.per_company).toBe(1);
        }
        // Case 5 (index 4): 3 companies, 1 per company
        if (i === 4) {
          expect(u.companies_count).toBe(3);
          expect(u.people_of_companies?.per_company).toBe(1);
        }
        // Case 6 (index 5): 3 companies, 1 per company
        if (i === 5) {
          expect(u.companies_count).toBe(3);
          expect(u.people_of_companies?.per_company).toBe(1);
        }

        // Counter-cases:
        // Case 4 (index 3): people count must not be copied to companies
        if (i === 3) {
          expect(u.companies_count ?? 0).not.toBe(3);
        }
        // Case 7 (index 6): unstated companies count
        if (i === 6) {
          expect(u.companies_count).toBeUndefined();
        }
      }
    }
  }, 300000);
});
