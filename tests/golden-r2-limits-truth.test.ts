import { describe, expect, it } from "vitest";
import { assertReplayInvariants, replay } from "./helpers/agentReplay";
import { request, SLUGS, company, linkedinOf } from "./helpers/a1World";
import { liveDispatcher, liveFlow } from "./helpers/g1R2World";
import { stageTruthBodyAr } from "../agent/src/finalize";
import { buildMethodology, type MissionFacts, type StageRecord } from "../agent/src/methodology";
import { itemNounOf } from "../src/lib/agentMission/itemNoun";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * GOLDEN RUN ROUND 2, G1, THE LIMITS TEXT (msn_9dc8f2db86bc5cf4959b): the companies source gave 242 companies, OUR place filter left 240 of them out, 2 were delivered, and the closing sentence and the limits row said «سُلّم ٢ من ٥ لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب».
 * That sentence is false when the source returned rows and a filter of ours removed them. The recorded counts (found, left out per reason) are said for EVERY stage and every filter, with the stage's own nouns, never only for people.
 */
const LIVE_COMPANIES = { found: 242, duplicates: 0, delivered: 2, excludedByReason: { filter_place: 240 }, pending: 0, reviewStop: null, stop: "source_exhausted" as const };
const OLD_CLAIM = "المصدر لم يعد يعطي نتائج";

describe("the truthful body, from the recorded counts", () => {
  it("LIVE: «وُجد ٢٤٢ شركة، ولم يُسلَّم ٢٤٠: ٢٤٠ من مكان غير الذي حددته» for a companies stage", () => {
    const body = stageTruthBodyAr({ ...LIVE_COMPANIES, noun: itemNounOf("الشركات المصرية في قطاع الكهروميكانيكا") })!;
    expect(body).toContain("وُجد ٢٤٢ شركة");
    expect(body).toContain("٢٤٠");
    expect(body).toContain("من مكان غير الذي حددته");
    expect(body).not.toContain(OLD_CLAIM);
    expect(body).not.toMatch(/[0-9]/);
  });

  it("every filter of ours is said the same way, for any stage's noun (period, account, place, media, replies, reposts, government)", () => {
    for (const [reason, words] of [["filter_period", "خارج الفترة المحددة"], ["filter_account", "من مصدر لم تسمّه"], ["filter_place", "من مكان غير الذي حددته"], ["filter_media", "لا يثبت أنه فيديو أو صورة"], ["filter_reply", "رد على غيره"], ["filter_repost", "إعادة نشر"], ["filter_government", "جهة حكومية أو عسكرية"]] as const) {
      const body = stageTruthBodyAr({ found: 40, duplicates: 0, delivered: 10, excludedByReason: { [reason]: 30 }, pending: 0, reviewStop: null, stop: "source_exhausted", noun: itemNounOf("التغريدات") });
      expect(body, reason).toContain("وُجد ٤٠ تغريدة");
      expect(body, reason).toContain(`٣٠ ${words}`);
    }
  });

  it("when the source gave rows and nothing of OURS left any out (only what the target did not need), the older true sentence stays (null)", () => {
    expect(stageTruthBodyAr({ found: 40, duplicates: 0, delivered: 30, excludedByReason: { target_reached: 10 }, pending: 0, reviewStop: null, stop: "source_exhausted" })).toBeNull();
    expect(stageTruthBodyAr({ found: 0, duplicates: 0, delivered: 0, excludedByReason: {}, pending: 0, reviewStop: null, stop: "source_exhausted" })).toBeNull();
  });
});

const rec = (over: Partial<StageRecord>): StageRecord => ({ found: 0, duplicates: 0, accepted: 0, excluded: 0, pending: 0, unchecked: 0, acceptedByRule: 0, acceptedByModel: 0, excludedByReason: {}, stop: "source_exhausted", ...over });
const companies = { key: "companies", title_ar: "الشركات المصرية في قطاع الكهروميكانيكا", endpoint_id: "tomba.companies.search.reveal", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, sample_rows: [], measured_by: [], columns: [{ key: "name", title_ar: "اسم الشركة" }], measured_cost_per_row_usd: 0, measured_from_calls: [], filters: [{ kind: "place", field: "city", values: ["مصر"], places: ["EG"] }] };
const plan = { summary_ar: "x", stages: [companies] as any, price: { totalCostUsd: 0, deliveredRows: 5, costPerFinalRowUsd: 0.0001, unitPricePoints: 88, reservePoints: 500, maxChargePoints: 440, overCap: false } as any } as PricedPlan;
const facts = (r: StageRecord): MissionFacts => ({ requestText: request, deliveredAt: new Date("2026-11-01T15:36:00Z"), reviewStop: null, stages: { companies: r } } as unknown as MissionFacts);

describe("the limits row of the delivered file", () => {
  it("LIVE: 242 found, 240 left out by the place filter, 2 delivered: the row says so, never that the source gave no more", () => {
    const m = buildMethodology({ plan, layouts: [], rowsByStage: { companies: [{ id: "a" }, { id: "b" }] }, facts: facts(rec({ found: 242, accepted: 2, excluded: 240, excludedByReason: { filter_place: 240 } })) });
    const limits = m.items.find((i) => i.label === "حدود هذا التسليم")!.values.join("\n");
    expect(limits).toContain("وُجد ٢٤٢ شركة");
    expect(limits).toContain("٢٤٠ من مكان غير الذي حددته");
    expect(limits).not.toContain(OLD_CLAIM);
  });
});

describe("the closing sentence of the mission (replay, live shape: 10 companies read, 8 of another country)", () => {
  it("says what was found and what the place filter removed, from the record", async () => {
    const rows = () => [
      ...Array.from({ length: 8 }, (_, i) => ({ ...company("berlin-em", 0), id: linkedinOf(`de-${i}`), name: `Berlin ${i} Electromechanical`, website_url: `de${i}.de`, linkedin_url: linkedinOf(`de-${i}`), city: "Berlin", country: "DE", street_address: "1 Hauptstrasse", phone_number: "" })),
      ...SLUGS.slice(0, 2).map((s, i) => ({ ...company(s, i), city: i === 0 ? "al qahirah" : "giza", country: "EG", street_address: "1234 egypt", phone_number: "" })),
    ];
    const r = await replay({ request, planning: liveFlow(), execution: () => [], answers: Array.from({ length: 200 }, () => liveDispatcher(rows)) });
    assertReplayInvariants(r, { expectStatus: "partial" });
    const summary = (await r.store.getMission(r.missionId))?.summary_ar ?? "";
    expect(summary).toContain("وُجد");
    expect(summary).toContain("شركات");
    expect(summary).toContain("من مكان غير الذي حددته");
    expect(summary).not.toContain(OLD_CLAIM);
    expect(summary).not.toMatch(/[0-9]/);
  });
});
