import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { buildRequestIndex } from "../src/lib/requests/buildIndex";
import { pendingSummaryAr } from "../src/lib/requests/pendingBlock";
import OpenMissionsList from "../src/components/mission/OpenMissionsList";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * ROUND 14, item 8: THE ORDERS PAGE. Live (the owner's screens): the running mission was BELOW the «مهام قيد الإعداد» list of old plans; its card showed both «قيد التنفيذ» and «قيد الدراسة الآن»; the tab «حجز مؤقت مُحرَّر ٦٤» read as an item of the list.
 * Now: running requests first; the plans that wait for approval are ONE line («٤ خطط تنتظر اعتمادك») that expands; one status word per state with a note that never repeats it; the last tab says what it is.
 */
const ME = "u-1";
const NOW = Date.parse("2026-11-03T15:50:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
let db: MemoryDb;
const mission = (id: string, status: string, createdAt: string, over: Record<string, unknown> = {}) => ({ id: `msn_${id}`, user_id: ME, status, request_text: `طلب ${id}`, created_at: createdAt, updated_at: createdAt, lease_until: null, job_id: null, summary_ar: null, error: null, ...over });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }); db = createMemoryDb(); });
afterEach(() => { vi.useRealTimers(); });

describe("one status word per state, and a note that does not repeat it", () => {
  it("a mission being studied: the word «قيد الدراسة», the note says what happens (not «قيد الدراسة الآن», not «قيد التنفيذ»)", async () => {
    db.seed("missions", [mission("p", "planning", ago(60_000), { lease_until: ago(-3_600_000) }), mission("q", "queued", ago(30_000))]);
    const idx = await buildRequestIndex({ from: (t: string) => db.from(t) } as never, { userId: ME, tab: "running", now: NOW });
    const rows = idx.rows.filter((r) => r.type === "mission") as Array<{ id: string; chipAr?: string; noteAr: string }>;
    const planning = rows.find((r) => r.id === "msn_p")!;
    const queued = rows.find((r) => r.id === "msn_q")!;
    expect(planning.chipAr).toBe("قيد الدراسة");
    expect(planning.noteAr).toBe("نجهّز خطتك الآن، ولم يُخصم منك شيء.");
    expect(queued.chipAr).toBe("في الانتظار");
    expect(queued.noteAr).toBe("ستبدأ تلقائيًا عند دورها، ولم يُخصم منك شيء.");
    for (const r of rows) {
      expect(r.noteAr).not.toContain(r.chipAr!);
      expect(r.noteAr).not.toMatch(/قيد التنفيذ|قيد الدراسة الآن|خلال دقائق|دقيقة|لحظات/);
      expect(checkCustomerText(r.noteAr, { maxChars: 400 }).issues).toEqual([]);
    }
  });
});

describe("the line of plans that wait", () => {
  it("«٤ خطط تنتظر اعتمادك» for four plans, with the right singular and dual", () => {
    const plans = (n: number) => Array.from({ length: n }, () => ({ status: "plan_ready" }));
    expect(pendingSummaryAr(plans(4))).toBe("٤ خطط تنتظر اعتمادك");
    expect(pendingSummaryAr(plans(1))).toBe("خطة واحدة تنتظر اعتمادك");
    expect(pendingSummaryAr(plans(2))).toBe("خطتان تنتظران اعتمادك");
    expect(pendingSummaryAr(plans(11))).toBe("١١ خطة تنتظر اعتمادك");
    expect(pendingSummaryAr([{ status: "needs_input" }])).toBe("طلب واحد ينتظر إجابتك");
    expect(pendingSummaryAr([{ status: "plan_ready" }, { status: "needs_input" }])).toContain("تنتظرك");
  });
  const items = Array.from({ length: 4 }, (_, i) => ({ id: `msn_${i}`, status: "plan_ready", stateAr: "الخطة جاهزة وتنتظر اعتمادك", requestText: `طلب قديم ${i}`, createdAt: ago(i * 3600_000), cancellable: true, conversationId: null }));
  it("collapsed by default: the one line and a button, none of the old requests in the markup", () => {
    const markup = renderToStaticMarkup(createElement(OpenMissionsList, { items, busyId: null, error: "", onCancel: () => undefined }));
    expect(markup).toContain("٤ خطط تنتظر اعتمادك");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("طلب قديم 0");
    expect(markup).not.toContain('data-testid="open-mission"');
  });
  it("it still lists them when opened (the component keeps every request and its cancel button)", () => {
    const src = readFileSync(new URL("../src/components/mission/OpenMissionsList.tsx", import.meta.url), "utf8");
    expect(src).toContain("open ? (");
    expect(src).toContain('data-testid="open-mission"');
    expect(src).toContain("onCancel(m.id)");
  });
  it("empty: nothing at all", () => {
    expect(renderToStaticMarkup(createElement(OpenMissionsList, { items: [], busyId: null, error: "", onCancel: () => undefined }))).toBe("");
  });
});

describe("the page orders its rows: running first, then the one line, then the rest; and explains the last tab", () => {
  const page = readFileSync(new URL("../src/app/dashboard/requests/page.tsx", import.meta.url), "utf8");
  it("running rows are put first and the pending block comes after them (before the first row that is not running)", () => {
    expect(page).toContain("const orderedRows = [...shownRows.filter(isRunningRow), ...shownRows.filter((r) => !isRunningRow(r))];");
    expect(page).toContain("i === firstOtherAt ? pendingBlock : null");
    expect(page.indexOf("orderedRows.map")).toBeLessThan(page.indexOf("firstOtherAt >= orderedRows.length"));
    // the block is no longer drawn above the list
    expect(page).not.toMatch(/\{tab === "all" && <OpenMissionsList/);
  });
  it("the tab that is a ledger state says what it is, and no longer reads like a line of the list", () => {
    // the approved word of the tab stays (small-fix-batch-2); it is EXPLAINED under the tabs when selected
    expect(page).toContain('["refunded", "حجز مؤقت مُحرَّر"]');
    expect(page).toContain("طلبات رُفع حجزها المؤقت كاملًا ولم يُخصم منك شيء.");
    expect(page).toContain('data-testid="tab-explain"');
    expect(checkCustomerText("طلبات رُفع حجزها المؤقت كاملًا ولم يُخصم منك شيء.", { maxChars: 400 }).issues).toEqual([]);
  });
});
