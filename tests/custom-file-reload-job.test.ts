import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { getJobIdForQuote } from "../src/lib/md5";
import { persistedFileShape } from "../src/lib/fileShapeMessage";
import { pickRestoredJobId } from "../src/lib/jobs/restoredJob";
import { createStatefulSupabase } from "./helpers/statefulSupabase";

/**
 * Reload simulation on the production schema: the conversation has a delivered job (quote Q1) and a later priced card that was
 * never approved (quote Q2, no job). The custom-file buttons are rendered from the STORED assistant row, so the row alone must
 * carry the file and the job it is made from.
 */
const rows = [
  { company_name: "Nile Energy", industry: "Utilities", website: "https://nile.example", location: "Cairo, Egypt", phone: "+20 100 000 0000", description: "Electricity distribution" },
  { company_name: "Delta Power", industry: "Utilities", website: "https://delta.example", location: "Alexandria, Egypt", phone: "+20 100 000 0001", description: "Power plants" },
];
const JOB_ID = getJobIdForQuote("Q1");
const UNAPPROVED_JOB_ID = getJobIdForQuote("Q2");

function conversation() {
  const message = (id: string, role: string, text: string, extra: Record<string, unknown>, minute: number) => ({
    id, conversation_id: "c1", user_id: "u1", role, content_ar: text, created_at: `2026-10-19T10:${String(minute).padStart(2, "0")}:00.000Z`, ...extra,
  });
  const store = createStatefulSupabase({
    tables: {
      profiles: [{ id: "u1", name: "سلمى" }],
      conversations: [{ id: "c1", user_id: "u1", status: "active", brief: null, title: "شركات كهرباء" }],
      messages: [
        message("m1", "user", "عايز شركتين كهرباء في مصر", { request_quote_id: "Q1", request_status: "accepted" }, 0),
        message("m2", "assistant", "أعددت لك خطة الاستخراج وعرض السعر بالنقاط", { quote: { quoteId: "Q1", items: [] } }, 1),
        message("m3", "user", "عايز شركتين كهرباء", { request_quote_id: "Q2", request_status: "quoted" }, 30),
        message("m4", "assistant", "أعددت لك خطة الاستخراج وعرض السعر بالنقاط", { quote: { quoteId: "Q2", items: [] } }, 31),
      ],
      jobs: [{ id: JOB_ID, user_id: "u1", status: "completed", delivered_units: 2, target_volume_max: 2, template_slug: "companies", endpoint_id: "icypeas.companies.search", platform: "companies", created_at: "2026-10-19T10:05:00.000Z" }],
      plans_quotes: [{ id: "Q1", user_id: "u1", status: "accepted" }, { id: "Q2", user_id: "u1", status: "quoted" }],
      llm_usage: [],
      credit_ledger: [],
    },
    files: { [`results/u1/${JOB_ID}/data.json`]: JSON.stringify({ rows, metadata: { country: "Egypt", entityType: "companies", title: "شركات" } }) },
  });
  const handler = new ChatHandler(store.client as any);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("no model call expected"); });
  return { store, send: (message: string) => handler.handleUserMessage({ userId: "u1", conversationId: "c1", message, userBalance: 5000 }) as Promise<any> };
}

const answer = (questionId: string, value: string) => JSON.stringify({ type: "clarification_answers", answers: [{ questionId, question: "؟", value }] });

/** What the page does for each stored assistant row on reload. */
const restoreFromStoredRows = (storedRows: any[]) =>
  storedRows.filter((row) => row.role === "assistant").map((row) => ({ id: row.id, fileShape: persistedFileShape(row.plan) }));

describe("custom-file buttons after a reload", () => {
  it("every free file reply is stored with its file and the delivered job, and reload restores both from the row alone", async () => {
    const { store, send } = conversation();
    const live: any[] = [];
    live.push(await send("رتب النتائج حسب المدينة تنازلياً"));
    live.push(await send("قسّم الملف شيت لكل مدينة"));
    const q = await send("رتب الملف حسب المحافظة");
    live.push(await send(answer("shape_sort_asc_required", q.clarificationItems[0].options[0])));
    const withFile = live.filter((reply) => reply.fileShape);
    expect(withFile).toHaveLength(3);
    for (const reply of withFile) expect(reply.fileShape.jobId).toBe(JOB_ID);

    const restored = restoreFromStoredRows(store.rows("messages")).filter((m) => m.fileShape);
    expect(restored).toHaveLength(3);
    for (const [index, message] of restored.entries()) {
      expect(message.fileShape).toEqual(withFile[index].fileShape);
      expect(message.fileShape!.jobId).toBe(JOB_ID);
    }
    // The old plan cards stay exactly as they were and gain no file.
    expect(restoreFromStoredRows(store.rows("messages")).filter((m) => ["m2", "m4"].includes(m.id) && m.fileShape)).toEqual([]);
  });

  it("a stored row without a job id (saved before this change) still restores its file", () => {
    const stored = { fileShape: { spec: { version: 1, sortBy: [{ column: "city", direction: "asc" }] }, descriptionAr: "ترتيب حسب «المدينة»" } };
    expect(persistedFileShape(stored)).toEqual(stored.fileShape);
    expect(persistedFileShape({ fileShape: { ...stored.fileShape, jobId: 12 } })).toEqual(stored.fileShape);
  });

  it("the job a reloaded page shows is the latest one that exists, not the unapproved quote's", () => {
    const candidates = [JOB_ID, UNAPPROVED_JOB_ID];
    expect(pickRestoredJobId(candidates, new Set([JOB_ID]))).toBe(JOB_ID);
    expect(pickRestoredJobId(candidates, new Set([JOB_ID, UNAPPROVED_JOB_ID]))).toBe(UNAPPROVED_JOB_ID);
    expect(pickRestoredJobId(candidates, new Set())).toBe(UNAPPROVED_JOB_ID);
    expect(pickRestoredJobId([], new Set())).toBeUndefined();
    expect(pickRestoredJobId(candidates, new Set([JOB_ID]), UNAPPROVED_JOB_ID)).toBe(UNAPPROVED_JOB_ID);
    expect(pickRestoredJobId(candidates, new Set([JOB_ID]), "job_other")).toBeUndefined();
  });

  it("the page shows the buttons from the stored file's own job and downloads that job", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("m.fileShape && (m.fileShape.jobId || activeJob)");
    expect(page).toContain("handleDownload(\"xlsx\", m.fileShape!.spec as FileSpec, m.fileShape!.jobId)");
    expect(page).toContain("const downloadJobId = jobIdOverride || activeJob?.jobId;");
    expect(page).toContain("pickRestoredJobId(");
  });

  it("card answers carry the delivered file's columns", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("...(activeJob?.resultColumns?.length ? { resultColumns: activeJob.resultColumns } : {})");
  });
});
