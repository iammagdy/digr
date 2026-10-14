import { describe, it, expect } from "vitest";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { generateCsvReport } from "../src/functions/shared/fileGenerators";

describe("Blocker C Reproduction: Billing Units vs Delivered Unique Data", () => {
  it("demonstrates the gap between raw provider items collected vs unique delivered rows in files", async () => {
    // Scenario: Provider delivers 10 raw items, but 2 are duplicates
    const rawProviderItems = [
      { id: "item_1", source_id: "1001", text: "منشور أول", likes_count: 50 },
      { id: "item_2", source_id: "1002", text: "منشور ثانٍ", likes_count: 30 },
      { id: "item_3", source_id: "1001", text: "منشور أول مكرر", likes_count: 50 }, // Duplicate of 1001
      { id: "item_4", source_id: "1003", text: "منشور ثالث", likes_count: 12 },
      { id: "item_5", source_id: "1004", text: "منشور رابع", likes_count: 85 },
      { id: "item_6", source_id: "1005", text: "منشور خامس", likes_count: 9 },
      { id: "item_7", source_id: "1002", text: "منشور ثانٍ مكرر", likes_count: 30 }, // Duplicate of 1002
      { id: "item_8", source_id: "1006", text: "منشور سادس", likes_count: 44 },
      { id: "item_9", source_id: "1007", text: "منشور سابع", likes_count: 19 },
      { id: "item_10", source_id: "1008", text: "منشور ثامن", likes_count: 67 },
    ];

    const rawCollectedCount = rawProviderItems.length;
    expect(rawCollectedCount).toBe(10);

    // Normalization pipeline deduplicates records by source_id
    const normalized = normalizeDataset({
      metadata: {
        platform: "X (تويتر)",
        title: "بحث تجريبي",
      },
      rows: rawProviderItems,
    });

    const uniqueDeliveredCount = normalized.rows.length;
    const duplicatesRemovedCount = normalized.kpis.duplicatesRemoved;

    expect(uniqueDeliveredCount).toBe(8);
    expect(duplicatesRemovedCount).toBe(2);

    // Generated files (CSV / Excel Sheet 1 / PDF) contain only unique records
    const csvBuffer = generateCsvReport(normalized);
    const csvString = csvBuffer.toString("utf8");
    const csvLines = csvString.trim().split("\n");
    // 1 header line + 8 data lines
    expect(csvLines.length).toBe(1 + 8);

    // INVARIANT REPRODUCTION:
    // In current worker chunk settlement, `delivered_units` is derived from raw chunk length:
    const currentWorkerDeliveredUnits = rawCollectedCount; // 10
    const researcherActualReceivedUnits = uniqueDeliveredCount; // 8

    // The gap:
    const discrepancy = currentWorkerDeliveredUnits - researcherActualReceivedUnits;
    expect(discrepancy).toBe(2);

    // This test formally documents and reproduces the divergence:
    // - Platform settled points based on currentWorkerDeliveredUnits (10)
    // - Researcher received and downloaded researcherActualReceivedUnits (8)
    // Resolution requires owner policy decision (Policy A: bill unique only vs Policy B: bill raw with transparent receipt).
  });
});
