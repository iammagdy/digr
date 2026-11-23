import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore, type Op } from "../agent/src/items/itemStore";
import { buildLiveSnapshot, deliveryRowsOf } from "../agent/src/stage2/liveSnapshot";
import { buildMissionFiles } from "../agent/src/workbook";
import {
  type ItemScope,
  type RelatedAccountCandidate,
  type WideningOffer,
  buildRetrievalUiDeliveryPayload,
  computeScopeCounters,
  formatDeliverPrimaryOption,
  filterValidatedCandidates,
  tagRowWithScope,
  validateCandidateAccount,
  SCOPE_COLUMN_KEY,
  SCOPE_COLUMN_TITLE_AR,
  SCOPE_LABEL_AR,
  WIDEN_TO_RELATED_ACCOUNTS_OPTION_AR,
  OFFICIAL_FULL_ARCHIVE_SEARCH_OPTION_AR,
} from "../agent/src/llmPlanner/widening";
import { checkCustomerText } from "../src/lib/agentMission/text";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { SUMMARY_SHEET_AR } from "../src/lib/modelPlanner/missionWorkbook";
import { cellsOf } from "./helpers/round11Worlds";

describe("TREG Phase 4: Scope-Separated Widening & Live Sheet Parity", () => {
  const planTemplate = (plannedRows = 20): PricedPlan => ({
    summary_ar: "جمع منشورات التوعية بالشائعات الصحية",
    stages: [
      {
        key: "posts",
        title_ar: "المنشورات",
        deliver: true,
        planned_rows: plannedRows,
        columns: [
          { key: "text", title_ar: "نص المنشور" },
          { key: "author", title_ar: "صاحب المنشور" },
        ],
      },
    ],
  } as unknown as PricedPlan);

  const createReplayRows = () => {
    // 5 primary account rows from @SaudiMOH
    const primaryRows = Array.from({ length: 5 }, (_, i) =>
      tagRowWithScope(
        {
          id: `moh_post_${i + 1}`,
          text: `بيان توضيحي من وزارة الصحة رقم ${i + 1}`,
          author: "SaudiMOH",
        },
        "primary_account"
      )
    );

    // 11 widened account rows from related fact-checker @No_Rumors
    const widenedRows = Array.from({ length: 11 }, (_, i) =>
      tagRowWithScope(
        {
          id: `norumors_post_${i + 1}`,
          text: `هيئة مكافحة الشائعات: حقيقة الشائعة رقم ${i + 1}`,
          author: "No_Rumors",
        },
        "widened_account"
      )
    );

    return { primaryRows, widenedRows };
  };

  it("Assertion 1, 2, 3: Replay produces honest primary count, widening finds related rows, and counts are strictly separated", () => {
    const { primaryRows, widenedRows } = createReplayRows();

    expect(primaryRows).toHaveLength(5);
    expect(widenedRows).toHaveLength(11);

    for (const r of primaryRows) {
      expect(r.scope).toBe("primary_account");
      expect(r.scope_label_ar).toBe("الحساب المطلوب");
    }

    for (const r of widenedRows) {
      expect(r.scope).toBe("widened_account");
      expect(r.scope_label_ar).toBe("حسابات قريبة / جهات رسمية");
    }

    const payload = buildRetrievalUiDeliveryPayload(primaryRows, widenedRows);

    // Primary count is strictly true_n (5), never 16 or 17
    expect(payload.true_n).toBe(5);
    expect(payload.primary_count).toBe(5);
    expect(payload.widened_count).toBe(11);
    expect(payload.scope_breakdown.primary).toBe(5);
    expect(payload.scope_breakdown.widened).toBe(11);
    expect(payload.scope_breakdown.total).toBe(16);

    // Summary explicitly distinguishes primary count from widened count
    expect(payload.summary_ar).toContain("٥ من الحساب المطلوب");
    expect(payload.summary_ar).toContain("١١ من حسابات التحقق والجهات الرسمية ذات الصلة");

    // Guard against merging widened rows into true_n
    expect(payload.true_n).not.toBe(16);
    expect(payload.true_n).not.toBe(17);
  });

  it("Assertion 4: Live Sheet Equality & Parity with Delivered Workbook", async () => {
    const { primaryRows, widenedRows } = createReplayRows();
    const allRows = [...primaryRows, ...widenedRows];

    const store = createMemoryStore();
    const log = await ItemStore.open(store, "msn_scope_parity");

    // Commit all 16 rows to ItemStore
    const ops: Op[] = allRows.map((r) => ({
      t: "item",
      stage: "posts",
      id: String(r.id),
      state: "accepted",
      by: "rule",
      row: { ...r },
    }));
    await log.commit(ops);
    await log.commit([{ t: "stop", stage: "posts", reason: "source_exhausted" }]);

    const plan = planTemplate(20);
    const snap = log.snapshotOfMemory();

    // 1. Build live snapshot
    const liveSnapshot = buildLiveSnapshot({
      missionId: "msn_scope_parity",
      plan,
      snap,
      status: "done",
      nowMs: Date.now(),
      stopReasonAr: "انتهت نتائج المصدر",
      coverageNoteAr: "تغطية شاملة للحساب المطلوب والحسابات الرسمية ذات الصلة",
    });

    // 2. Build delivered workbook using runMission finalize pattern
    const { plan: deliveredPlan, rowsByStage } = deliveryRowsOf(plan, snap);
    const built = await buildMissionFiles(deliveredPlan, rowsByStage, undefined, undefined, { approvedPlan: plan });
    const fileSheets = await cellsOf(built.xlsx);

    // Sheet rows from delivered workbook (excluding summary sheet)
    const deliveredSheetName = Object.keys(fileSheets).find((n) => n !== SUMMARY_SHEET_AR)!;
    const [workbookHeaders, ...workbookRows] = fileSheets[deliveredSheetName];

    // Assert parity: liveSnapshot.rows.length === deliveredWorkbook.rows.length
    expect(liveSnapshot.rows.length).toBe(16);
    expect(workbookRows.length).toBe(16);
    expect(liveSnapshot.rows.length).toBe(workbookRows.length);

    // Scope counters assertion
    expect(liveSnapshot.counters.primary).toBe(5);
    expect(liveSnapshot.counters.widened).toBe(11);

    // UI delivery true_n assertion
    const uiPayload = buildRetrievalUiDeliveryPayload(primaryRows, widenedRows);
    expect(uiPayload.true_n).toBe(5);

    // Explicit scope column is present in both live headers and workbook headers
    const liveHeaders = liveSnapshot.sheets[0].headers;
    expect(liveHeaders).toContain(SCOPE_COLUMN_TITLE_AR);
    expect(workbookHeaders).toContain(SCOPE_COLUMN_TITLE_AR);

    // Check scope values in workbook rows
    const scopeColIndex = workbookHeaders.indexOf(SCOPE_COLUMN_TITLE_AR);
    expect(scopeColIndex).toBeGreaterThanOrEqual(0);

    const first5ScopeValues = workbookRows.slice(0, 5).map((r) => r[scopeColIndex]);
    const next11ScopeValues = workbookRows.slice(5, 16).map((r) => r[scopeColIndex]);

    expect(first5ScopeValues.every((val) => val === SCOPE_LABEL_AR.primary_account)).toBe(true);
    expect(next11ScopeValues.every((val) => val === SCOPE_LABEL_AR.widened_account)).toBe(true);

    // Done snapshot embeds stop reason and coverage note
    expect(liveSnapshot.stop_reason_ar).toBe("انتهت نتائج المصدر");
    expect(liveSnapshot.coverage_note_ar).toBe("تغطية شاملة للحساب المطلوب والحسابات الرسمية ذات الصلة");
  });

  it("Assertion 5: Customer Options present verbatim Arabic text passing checkCustomerText", () => {
    const opt1 = formatDeliverPrimaryOption(5);
    const opt2 = WIDEN_TO_RELATED_ACCOUNTS_OPTION_AR;
    const opt3 = OFFICIAL_FULL_ARCHIVE_SEARCH_OPTION_AR;

    // Verbatim text match
    expect(opt1).toBe("سلّمني الموجود فقط (عدد ٥) من الحساب المطلوب");
    expect(opt2).toBe("وسّع البحث ليشمل حسابات التحقق والجهات الصحية الرسمية ذات الصلة");
    expect(opt3).toBe("البحث في الأرشيف التاريخي الشامل للمنصة (بتكلفة إضافية)");

    // Customer text guard compliance (zero issues, no English words, no ASCII digits)
    expect(checkCustomerText(opt1).issues).toEqual([]);
    expect(checkCustomerText(opt2).issues).toEqual([]);
    expect(checkCustomerText(opt3).issues).toEqual([]);

    expect(opt1).not.toMatch(/[0-9]/);
    expect(opt2).not.toMatch(/[0-9]/);
    expect(opt3).not.toMatch(/[0-9]/);

    expect(opt1).not.toMatch(/[a-zA-Z]/);
    expect(opt2).not.toMatch(/[a-zA-Z]/);
    expect(opt3).not.toMatch(/[a-zA-Z]/);
  });

  it("Invariant: Zero Discrepancy Invariant (Arrival & Dedup Guarantee)", async () => {
    const store = createMemoryStore();
    const log = await ItemStore.open(store, "msn_dedup_invariant");
    const plan = planTemplate(20);

    // 1. Stage items: 2 accepted, 1 pending, 1 excluded, 1 duplicate
    const row1 = tagRowWithScope({ id: "post_1", text: "منشور أول", author: "SaudiMOH" }, "primary_account");
    const row2 = tagRowWithScope({ id: "post_2", text: "منشور ثان", author: "SaudiMOH" }, "primary_account");
    const rowPending = { id: "post_pending", text: "منشور قيد الفحص", author: "SaudiMOH" };
    const rowExcluded = { id: "post_excluded", text: "منشور خارج الموضوع", author: "SaudiMOH" };

    await log.commit([
      { t: "item", stage: "posts", id: row1.id, state: "accepted", by: "rule", row: row1 },
      { t: "item", stage: "posts", id: rowPending.id, state: "pending", by: "model", row: rowPending },
      { t: "item", stage: "posts", id: rowExcluded.id, state: "excluded", reason: "customer_exclusion", row: rowExcluded },
    ]);

    let snap = log.snapshotOfMemory();
    let live = buildLiveSnapshot({ missionId: "msn_dedup_invariant", plan, snap, status: "running", nowMs: 100 });

    // Only accepted rows appear in the live sheet
    expect(live.rows.map((r) => r.id)).toEqual(["post_1"]);
    expect(live.counters.primary).toBe(1);

    // Commit second accepted row and duplicate of post_1
    await log.commit([
      { t: "item", stage: "posts", id: row2.id, state: "accepted", by: "rule", row: row2 },
      { t: "item", stage: "posts", id: "post_1", state: "accepted", by: "rule", row: { ...row1, text: "تكرار" } },
      { t: "dup", stage: "posts", n: 1 },
    ]);

    snap = log.snapshotOfMemory();
    live = buildLiveSnapshot({ missionId: "msn_dedup_invariant", plan, snap, status: "running", nowMs: 200 });

    // Both post_1 and post_2 appear once; duplicate is not shown
    expect(live.rows.map((r) => r.id)).toEqual(["post_1", "post_2"]);
    expect(live.counters.primary).toBe(2);

    // Row 1 once accepted never disappears
    expect(live.rows.some((r) => r.id === "post_1")).toBe(true);

    // Resolve pending to accepted
    await log.commit([
      { t: "resolve", stage: "posts", id: rowPending.id, state: "accepted", by: "model" },
    ]);

    snap = log.snapshotOfMemory();
    live = buildLiveSnapshot({ missionId: "msn_dedup_invariant", plan, snap, status: "running", nowMs: 300 });
    expect(live.rows.map((r) => r.id)).toEqual(["post_1", "post_pending", "post_2"]);
  });

  it("Candidate Validation: validates proposed accounts via profile endpoint", async () => {
    const candidate1: RelatedAccountCandidate = {
      handle: "No_Rumors",
      role: "fact_checker",
      rationale: "حساب رسمي لمكافحة الشائعات والتحقق",
    };
    const candidate2: RelatedAccountCandidate = {
      handle: "Invalid_Nonexistent_Handle",
      role: "media_outlet",
      rationale: "حساب وهمي غير موجود",
    };

    const mockProfileLookup = async (handle: string) => {
      if (handle === "No_Rumors") return { exists: true, verified: true };
      return { exists: false };
    };

    const valid1 = await validateCandidateAccount(candidate1, mockProfileLookup);
    expect(valid1).not.toBeNull();
    expect(valid1?.handle).toBe("No_Rumors");
    expect(valid1?.verifiedProfile).toBe(true);

    const valid2 = await validateCandidateAccount(candidate2, mockProfileLookup);
    expect(valid2).toBeNull();

    const filtered = await filterValidatedCandidates([candidate1, candidate2], mockProfileLookup);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].handle).toBe("No_Rumors");
  });
});
