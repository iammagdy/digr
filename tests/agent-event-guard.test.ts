import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countPhraseAr, countsLineAr, guardEvent } from "../src/lib/agentMission/eventText";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { createMemoryStore } from "../agent/src/memoryStore";
import { buildMissionNotice } from "../src/lib/agentMission/notices";
import { SIGNUP_TO_APPROVE_AR } from "../src/lib/agentMission/customerActions";
import { AGENT_CLOSE_PAGE_LINE_AR, AGENT_QUEUE_LINE_AR } from "../src/lib/agentMission/constants";

describe("the event text guard", () => {
  it("lets a clean Arabic line through with Arabic-Indic digits and keeps the counts", () => {
    const g = guardEvent({ kind: "progress", message_ar: "لقيت 12 منشورًا مناسبًا", counts: { rows: 12, stage: 1 } });
    expect(g).toMatchObject({ replaced: false, message_ar: "لقيت ١٢ منشورًا مناسبًا", counts: { rows: 12, stage: 1 } });
  });

  it("replaces English, snake_case, provider names, dollar amounts and internal ids by the fixed Arabic line of the kind", () => {
    for (const bad of [
      "20 rows, 1 stages, 4 reserve_points, 165 points_per_row_x1000",
      "charged_points rows_tweets",
      "Calling the x.x.search-posts-all endpoint",
      "نستخدم TREG لجلب البيانات",
      "التكلفة ٠٫٠٢ دولار",
      "المهمة msn_abcdef12345 بدأت",
      "نستخدم فاير كراول للقراءة",
    ]) {
      const g = guardEvent({ kind: "progress", message_ar: bad });
      expect(g.replaced, bad).toBe(true);
      expect(checkCustomerText(g.message_ar).issues).toEqual([]);
    }
    expect(guardEvent({ kind: "result", message_ar: "done" }).message_ar).toBe("انتهى عمل الوكيل على مهمتك.");
  });

  it("the numbers live in the counts JSON: only finite numbers under short snake_case keys are kept", () => {
    const g = guardEvent({ kind: "progress", message_ar: "تقدّم جيد", counts: { saved: 3, "bad key": 1, x: Number.NaN, text: "7" as any, planned: 10 } });
    expect(g.counts).toEqual({ saved: 3, planned: 10 });
  });

  it("every store applies it: a technical sentence never reaches mission_events", async () => {
    const store = createMemoryStore();
    await store.addEvent("msn_x", { kind: "plan", message_ar: "20 rows, 1 stages", counts: { rows: 20, reserve_points: 4 } });
    expect(store.events[0].message_ar).toBe("جهّز الوكيل خطة لمهمتك.");
    expect(store.events[0].counts).toEqual({ rows: 20, reserve_points: 4 });
  });

  it("counts are shown with Arabic labels, never as raw keys; a key with no customer wording is left out", () => {
    expect(countsLineAr({ rows: 20, stages: 1, reserve_points: 4, unit_points_x1000: 165 })).toBe("الصفوف: ٢٠، المراحل: ١، المحجوز بالنقاط: ٤، سعر الصف (بالألف): ١٦٥");
    expect(countPhraseAr("stage_2_rows", 6)).toBe("صفوف المرحلة ٢: ٦");
    expect(countPhraseAr("rows_tweets", 3)).toBeNull();
    expect(countsLineAr({ charged_points: 4, secret_thing: 9 })).toBe("المخصوم بالنقاط: ٤");
    expect(countsLineAr({ stage: 1 })).not.toMatch(/[A-Za-z_]/);
  });
});

/** The Arabic literals the code itself writes for a customer: every one of them must pass the same check (a static scan, so a new line cannot slip in unchecked). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? (name === "node_modules" ? [] : sourceFiles(p)) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("every line the code writes for the customer passes the Arabic-only check", () => {
  const files = [...sourceFiles("agent/src"), ...sourceFiles("src/lib/agentMission"), "src/lib/server/missionNotify.ts"];

  it("message_ar / summary literals in the worker and the mission library", () => {
    const found: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:message_ar|summary_ar|question_ar)\s*[:=]\s*(?:[^"`'\n]{0,40}\?\s*)?(["`])((?:\\.|(?!\1).)*)\1/g)) {
        const text = m[2].replace(/\$\{[^}]*\}/g, "٠");
        if (/[؀-ۿ]/.test(text)) found.push(text);
      }
    }
    expect(found.length).toBeGreaterThan(8);
    for (const text of found) expect(checkCustomerText(text, { maxChars: 1100 }).issues, text).toEqual([]);
  });

  it("the fixed sentences and the notices", () => {
    for (const t of [AGENT_CLOSE_PAGE_LINE_AR, AGENT_QUEUE_LINE_AR, SIGNUP_TO_APPROVE_AR]) expect(checkCustomerText(t, { maxChars: 1100 }).issues, t).toEqual([]);
    for (const kind of ["started", "completed", "partial", "failed", "unserved"] as const) {
      const n = buildMissionNotice(kind, { delivered: 18, planned: 20, chargedPoints: 28, releasedPoints: 4, hasJob: true });
      for (const t of [n.title, n.body, ...(n.email ? Object.values(n.email) : [])]) {
        if (t) expect(checkCustomerText(t, { maxChars: 1100 }).issues, `${kind}: ${t}`).toEqual([]);
      }
    }
  });
});
