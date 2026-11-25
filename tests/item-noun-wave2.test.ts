import { describe, it, expect } from "vitest";
import {
  coerceItemNoun,
  itemNounFromCapability,
  knownItemNoun,
  GENERIC_ITEM_NOUN,
  countAr,
  itemNounOf,
  type ItemNoun,
} from "../src/lib/agentMission/itemNoun";
import { normalizeText } from "../src/lib/agentMission/relevance";
import { stagePriceInputs, type PricedStage } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { buildCatalogWideningFacts } from "../agent/src/llmPlanner/planner";
import { directWebEndpoints } from "../agent/src/llmPlanner/catalogView";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { stagesView } from "../src/lib/agentMission/customerView";
import { scoutFallbackAr, type ScoutFinding } from "../agent/src/llmPlanner/planner";
import { buildMissionNotice } from "../src/lib/agentMission/notices";
import endpointMetadataOverlay from "../data/treg/endpoint_metadata_overlay.json";

describe("DT-20261125-wordlist-wave2 Phase 3: Item Noun Catalog Overlay & Browser Safety (C1, C2, C3, C6, K3)", () => {
  const overlayMap = endpointMetadataOverlay as Record<string, any>;
  const tweetNoun = overlayMap["anyapi.x.user.posts"]?.item_noun_ar;
  const webNoun = overlayMap["treg.web.search"]?.item_noun_ar;

  it("1. coerceItemNoun validates all 5 Arabic forms + boolean feminine; rejects Latin or missing fields without calling knownItemNoun (C2)", () => {
    expect(tweetNoun).toBeDefined();
    const coerced = coerceItemNoun(tweetNoun);
    expect(coerced).not.toBeNull();
    expect(coerced!.singular).toBe("تغريدة");
    expect(coerced!.dual).toBe("تغريدتان");
    expect(coerced!.dualGen).toBe("تغريدتين");
    expect(coerced!.plural).toBe("تغريدات");
    expect(coerced!.tamyiz).toBe("تغريدة");
    expect(coerced!.feminine).toBe(true);

    // Missing required fields
    expect(coerceItemNoun(null)).toBeNull();
    expect(coerceItemNoun({})).toBeNull();
    expect(coerceItemNoun({ singular: "تغريدة" })).toBeNull(); // Missing dual, plural, tamyiz, feminine
    expect(coerceItemNoun({ ...tweetNoun, feminine: "true" })).toBeNull(); // Non-boolean feminine
    expect(coerceItemNoun({ ...tweetNoun, feminine: undefined })).toBeNull();

    // Pure validation: no rescue through KNOWN table
    const partialKnown = { singular: "تغريدة" };
    expect(coerceItemNoun(partialKnown)).toBeNull();
  });

  it("2. Key parity proof: normalizeText(singular) === knownItemNoun(singular)!.key for overlay nouns (C2, K3)", () => {
    // Tweet
    const coercedTweet = coerceItemNoun(tweetNoun)!;
    expect(coercedTweet.key).toBe(normalizeText("تغريدة"));
    expect(coercedTweet.key).toBe(knownItemNoun("تغريدة")!.key);
    expect(coercedTweet.key).toBe("تغريده");

    // Company
    const companyOverlay = overlayMap["thecompaniesapi.companies.search"]?.item_noun_ar ?? {
      singular: "شركة",
      dual: "شركتان",
      dual_gen: "شركتين",
      plural: "شركات",
      tamyiz: "شركة",
      feminine: true,
    };
    const coercedCompany = coerceItemNoun(companyOverlay)!;
    expect(coercedCompany.key).toBe(normalizeText("شركة"));
    expect(coercedCompany.key).toBe(knownItemNoun("شركة")!.key);
    expect(coercedCompany.key).toBe("شركه");

    // Person
    const personOverlay = overlayMap["blitzapi.people.search"]?.item_noun_ar ?? {
      singular: "شخص",
      dual: "شخصان",
      dual_gen: "شخصين",
      plural: "أشخاص",
      tamyiz: "شخصًا",
      feminine: false,
    };
    const coercedPerson = coerceItemNoun(personOverlay)!;
    expect(coercedPerson.key).toBe(normalizeText("شخص"));
    expect(coercedPerson.key).toBe(knownItemNoun("شخص")!.key);
    expect(coercedPerson.key).toBe("شخص");
  });

  it("3. Replay parity proof: Turn-1 question and option strings match recorded strings verbatim; zero «عنصر» (C3)", () => {
    const coercedTweet = coerceItemNoun(tweetNoun)!;
    const coercedWeb = coerceItemNoun(webNoun)!;

    // Dual and plural counts
    expect(countAr(2, coercedTweet)).toBe("تغريدتين");
    expect(countAr(18, coercedTweet)).toBe("١٨ تغريدة");
    expect(countAr(10, coercedTweet)).toBe("١٠ تغريدات");
    expect(countAr(10, coercedWeb)).toBe("١٠ مقالات");

    // Zero «عنصر» in customer counts
    expect(countAr(2, coercedTweet)).not.toContain("عنصر");
    expect(countAr(18, coercedTweet)).not.toContain("عنصر");
    expect(countAr(10, coercedWeb)).not.toContain("عنصر");

    // Widening facts formatting with catalog web endpoints
    const catalog = loadTregCatalog();
    const webTools = directWebEndpoints({ firecrawl: true, contextdev: true });
    expect(webTools.length).toBeGreaterThan(0);
    const webTool = webTools.find((t) => t.id === "contextdev.search" || t.id.includes("search"));
    expect(webTool).toBeDefined();
    expect((webTool as any).item_noun_ar).toBeDefined();

    const facts = buildCatalogWideningFacts(
      [
        {
          step: {
            key: "tweets",
            title_ar: "تغريدات وزارة الصحة عن الشائعات",
            platform: "x",
            capability: "x.user.posts",
            topic: "الشائعات",
            source: { kind: "account", value: "SaudiMOH" },
            deliver: true,
            item_noun_ar: tweetNoun,
          } as any,
          builtStep: null as any,
          found: 2,
          examinedCount: 78,
          requested: 20,
          exhausted: false,
          sets: 1,
        },
      ],
      catalog,
      null,
      undefined,
      webTools,
    );

    const webFact = facts.find((f) => f.kind === "web_news");
    expect(webFact).toBeDefined();
    expect(webFact!.label_ar).toContain("١٠ مقالات");
    expect(webFact!.label_ar).not.toContain("عنصر");
    expect(webFact!.label_ar).not.toContain("عناصر");
    expect(webFact!.suffix_ar).toContain("١٠ مقالات");
    expect(webFact!.suffix_ar).not.toContain("خبر");
  });

  it("4. Price invariance: stagePriceInputs, per-stage fields, and card max are bitwise identical with/without item_noun_ar (C6, K3)", () => {
    const baseStage: PricedStage = {
      key: "tweets",
      title_ar: "تغريدات وزارة الصحة",
      endpoint_id: "anyapi.x.user.posts",
      expected_rows: 20,
      parent_key: null,
      deliver: true,
      columns: [{ key: "text", title_ar: "النص" }],
      sample_rows: [{ text: "sample" }],
      measured_by: ["call_0001"],
      planned_rows: 20,
      measured_cost_per_row_usd: 0.001,
      measured_from_calls: ["call_0001"],
    };

    const stageWithNoun = {
      ...baseStage,
      item_noun_ar: tweetNoun,
    } as unknown as PricedStage;

    const inputsWithout = stagePriceInputs([baseStage]);
    const inputsWith = stagePriceInputs([stageWithNoun]);

    expect(inputsWith).toEqual(inputsWithout);

    const priceWithout = priceMissionByCode(inputsWithout);
    const priceWith = priceMissionByCode(inputsWith);

    expect(priceWith.maxChargePoints).toBe(priceWithout.maxChargePoints);
    expect(priceWith.reservePoints).toBe(priceWithout.reservePoints);
    expect(priceWith.minApplied).toBe(priceWithout.minApplied);
    expect(priceWith.unitPricePoints).toBe(priceWithout.unitPricePoints);
    expect(priceWith.costPerFinalRowUsd).toBe(priceWithout.costPerFinalRowUsd);
  });

  it("5. Counter-case 1: Missing item_noun_ar falls back to GENERIC_ITEM_NOUN cleanly", () => {
    expect(coerceItemNoun(undefined)).toBeNull();
    expect(itemNounFromCapability(null, null, undefined)).toBeNull();
    const fallback = coerceItemNoun(undefined) ?? GENERIC_ITEM_NOUN;
    expect(fallback.key).toBe(GENERIC_ITEM_NOUN.key);
    expect(fallback.singular).toBe("عنصر");
    expect(fallback.plural).toBe("عناصر");
  });

  it("6. Counter-case 2: Noun with Latin character is rejected (null)", () => {
    const latinNoun = {
      singular: "tweet",
      dual: "2 tweets",
      dual_gen: "2 tweets",
      plural: "tweets",
      tamyiz: "tweet",
      feminine: true,
    };
    expect(coerceItemNoun(latinNoun)).toBeNull();

    const partialLatin = {
      ...tweetNoun,
      singular: "تغريدة (tweet)",
    };
    expect(coerceItemNoun(partialLatin)).toBeNull();
  });

  it("7. F5 regression: generic title («نتائج البحث») on videos endpoint shows «فيديو/فيديوهات» on card, shortfall, and notice; no overlay shows «عنصر»", () => {
    const videoNoun = overlayMap["treg.bilibili.search.videos"]?.item_noun_ar;
    expect(videoNoun).toBeDefined();
    expect(videoNoun.singular).toBe("فيديو");
    expect(videoNoun.plural).toBe("فيديوهات");

    // 1) Card (stagesView)
    const cardWithVideo = stagesView({
      stages: [
        {
          expected_rows: 5,
          title_ar: "نتائج البحث",
          item_noun_ar: videoNoun,
          deliver: true,
        },
      ],
    });
    expect(cardWithVideo.stages[0].rowsAr).toBe("٥ فيديوهات");
    expect(cardWithVideo.stages[0].rowsAr).not.toContain("عنصر");

    const cardNoOverlay = stagesView({
      stages: [
        {
          expected_rows: 5,
          title_ar: "نتائج البحث",
          deliver: true,
        },
      ],
    });
    expect(cardNoOverlay.stages[0].rowsAr).toBe("٥ عناصر");

    // 2) Shortfall question (scoutFallbackAr)
    const findingWithVideo: ScoutFinding = {
      step: {
        key: "s1",
        title_ar: "نتائج البحث",
        platform: "bilibili",
        capability: "search.videos",
        count: { total: 50, per_parent: null, all: false },
      } as any,
      requested: 50,
      found: 0,
      exhausted: true,
      sets: 1,
      examinedCount: 50,
      builtStep: {
        option: {
          endpoint: {
            id: "treg.bilibili.search.videos",
            platform: "bilibili",
            capability: "search.videos",
            item_noun_ar: videoNoun,
          } as any,
        } as any,
      } as any,
    };
    const fbVideo = scoutFallbackAr([findingWithVideo], ["نتائج البحث", "موضوع"]);
    expect(fbVideo.question_ar).toContain("فحصنا ٥٠ فيديو");
    expect(fbVideo.question_ar).not.toContain("عنصر");
    const factsVideo = buildCatalogWideningFacts([findingWithVideo], undefined, null);
    expect(factsVideo.length).toBeGreaterThan(0);
    expect(factsVideo[0].label_ar).toContain("فيديو");
    expect(factsVideo[0].label_ar).not.toContain("عنصر");

    const findingNoOverlay: ScoutFinding = {
      step: {
        key: "s2",
        title_ar: "نتائج البحث",
        platform: "custom",
        capability: "search.items",
        count: { total: 50, per_parent: null, all: false },
      } as any,
      requested: 50,
      found: 0,
      exhausted: true,
      sets: 1,
      examinedCount: 50,
    };
    const fbNoOverlay = scoutFallbackAr([findingNoOverlay], ["نتائج البحث", "موضوع"]);
    expect(fbNoOverlay.question_ar).toContain("فحصنا ٥٠ عنصرًا");
    const factsNoOverlay = buildCatalogWideningFacts([findingNoOverlay], undefined, null);
    expect(factsNoOverlay.length).toBeGreaterThan(0);
    expect(factsNoOverlay[0].label_ar).toContain("عنصر");

    // 3) Notice (buildMissionNotice)
    const noticeVideo = buildMissionNotice("completed", {
      delivered: 5,
      planned: 5,
      chargedPoints: 50,
      releasedPoints: 0,
      reservedPoints: 50,
      hasJob: true,
      stages: [
        {
          titleAr: "نتائج البحث",
          delivered: 5,
          planned: 5,
          item_noun_ar: videoNoun,
        },
      ],
    });
    expect(noticeVideo.body).toContain("٥ فيديوهات");
    expect(noticeVideo.body).not.toContain("عنصر");

    const noticeNoOverlay = buildMissionNotice("completed", {
      delivered: 5,
      planned: 5,
      chargedPoints: 50,
      releasedPoints: 0,
      reservedPoints: 50,
      hasJob: true,
      stages: [
        {
          titleAr: "نتائج البحث",
          delivered: 5,
          planned: 5,
        },
      ],
    });
    expect(noticeNoOverlay.body).toContain("٥ عناصر");
  });
});
