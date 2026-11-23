import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { planWithLlm } from "../agent/src/llmPlanner/planner";

/**
 * P0 Replay & Acceptance Guard: Deep Account Timeline Acceptance (DT-20261123-timeline-acceptance)
 * Based on live case msn_a9e3167d3cb1d7e60ef7 (@SaudiMOH rumors).
 *
 * Invariant: «accepted» must strictly equal rows that pass the topic relevance judge,
 * never raw fetched rows. Scan continues while accepted < target within budget,
 * and the card / shortfall question reflects true on-topic count.
 */
describe("P0 Hotfix: Deep Account Timeline Acceptance & Shortfall Guard", () => {
  const cat = loadTregCatalog();
  const timelineEp = cat.endpoints.find(
    (e) => e.platform === "x" && e.capability === "x.user.posts" && e.inputs.some((i) => i.name === "handle")
  )!;

  it("Must-pass replay: page 1 has 20 off-topic posts, page 2 has 3 on-topic -> scan reads page 2, card reflects 3 on-topic items", async () => {
    let judgeCount = 0;
    const probedCursors: string[] = [];

    const page1Tweets = Array.from({ length: 20 }, (_, i) => ({
      id: `p1_t${i + 1}`,
      text: `إعلان عام وتوجيهات صحية روتينية رقم ${i + 1}`,
      published_at: new Date(Date.now() - i * 3600 * 1000).toISOString(),
    }));

    const page2Tweets = Array.from({ length: 20 }, (_, i) => ({
      id: `p2_t${i + 1}`,
      text: i < 3 ? `بيان رسمي لنفي شائعة صحية متداولة رقم ${i + 1}` : `معلومات وقائية عامة رقم ${i + 1}`,
      published_at: new Date(Date.now() - (20 + i) * 3600 * 1000).toISOString(),
    }));

    const mockProbe = vi.fn(async (endpointId: string, params: Record<string, unknown>) => {
      const cursor = params.cursor as string | undefined;
      probedCursors.push(cursor ?? "initial");
      if (!cursor) {
        return {
          ok: true,
          rows_in_page: 20,
          call_id: "call_page_1",
          items: page1Tweets,
          has_more: true,
          next_cursor: "cursor_page_2",
          charge_usd: 0.001,
        };
      }
      if (cursor === "cursor_page_2") {
        return {
          ok: true,
          rows_in_page: 20,
          call_id: "call_page_2",
          items: page2Tweets,
          has_more: false,
          next_cursor: null,
          charge_usd: 0.001,
        };
      }
      return { ok: true, rows_in_page: 0, call_id: "call_empty", items: [], has_more: false, next_cursor: null };
    });

    const mockReadPage = vi.fn(async (callId: string) => {
      if (callId === "call_page_1") {
        return { output: { data: { tweets: page1Tweets } } };
      }
      if (callId === "call_page_2") {
        return { output: { data: { tweets: page2Tweets } } };
      }
      return { output: { data: { tweets: [] } } };
    });

    const mockModel: any = vi.fn(async ({ tool }: any) => {
      if (tool?.name === "request_plan") {
        return {
          input: {
            decision: "plan",
            understanding_ar: "جمع تغريدات حساب وزارة الصحة عن الشائعات",
            steps: [
              {
                key: "moh_rumor_tweets",
                platform: "x",
                capability: timelineEp.capability,
                source: { kind: "account", value: "@SaudiMOH" },
                topic: "شائعات",
                count: { total: 20 },
                deliver: true,
                title_ar: "تغريدات نفي الشائعات",
              },
            ],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "tool_choice") {
        return {
          input: {
            options: [
              {
                endpoint_id: timelineEp.id,
                params_json: JSON.stringify({ handle: "SaudiMOH", limit: 20 }),
                cursor_input: "cursor",
                more_params_json: [],
              },
            ],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "field_map") {
        return {
          input: {
            fields: { id: ["id"], text: ["text"] },
            extra: [],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "judge_sample") {
        judgeCount++;
        if (judgeCount === 1) {
          // Page 1: 0 on-topic matches
          return { input: { matching_indices: [] }, costUsd: 0.001 };
        }
        // Page 2: 3 on-topic matches (indices 0, 1, 2)
        return { input: { matching_indices: [0, 1, 2] }, costUsd: 0.001 };
      }
      return { input: {}, costUsd: 0.001 };
    });

    const logs: string[] = [];
    const res = await planWithLlm(
      {
        words: ["تغريدات حساب @SaudiMOH عن الشائعات"],
        request: "",
        scoutAllowed: false,
      },
      {
        model: mockModel,
        probe: mockProbe as any,
        readPage: mockReadPage as any,
        catalog: cat,
        access: null,
        today: "2026-11-23",
        log: (msg) => logs.push(msg),
      }
    );

    expect(res.kind).toBe("plan");
    if (res.kind === "plan") {
      // Card count strictly matches accepted on-topic count (3), never the raw 20!
      expect(res.plan.stages[0].planned_rows).toBe(3);
      expect(res.plan.stages[0].expected_rows).toBe(3);
    }

    // Traversed to page 2 because page 1 had 0 matches
    expect(probedCursors).toContain("initial");
    expect(probedCursors).toContain("cursor_page_2");
    expect(probedCursors.length).toBe(2);

    // Timeline scan log accurately records 2 pages, 40 examined, and accepted=3
    const scanLog = logs.find((l) => l.startsWith("llm_planner_timeline_scan"));
    expect(scanLog).toBeDefined();
    expect(scanLog).toContain("pages=2");
    expect(scanLog).toContain("examined=40");
    expect(scanLog).toContain("accepted=3");
    expect(scanLog).toContain("reason=terminal_cursor");
  });

  it("Counter-case: page 1 is all on-topic -> stops at page 1 with reason=target_reached and delivers 20", async () => {
    let judgeCount = 0;
    const probedCursors: string[] = [];

    const page1Tweets = Array.from({ length: 20 }, (_, i) => ({
      id: `p1_t${i + 1}`,
      text: `بيان رسمي عاجل لنفي شائعة صحية رقم ${i + 1}`,
      published_at: new Date(Date.now() - i * 3600 * 1000).toISOString(),
    }));

    const mockProbe = vi.fn(async (endpointId: string, params: Record<string, unknown>) => {
      const cursor = params.cursor as string | undefined;
      probedCursors.push(cursor ?? "initial");
      return {
        ok: true,
        rows_in_page: 20,
        call_id: "call_page_1",
        items: page1Tweets,
        has_more: true,
        next_cursor: "cursor_page_2",
        charge_usd: 0.001,
      };
    });

    const mockReadPage = vi.fn(async () => ({
      output: { data: { tweets: page1Tweets } },
    }));

    const mockModel: any = vi.fn(async ({ tool }: any) => {
      if (tool?.name === "request_plan") {
        return {
          input: {
            decision: "plan",
            understanding_ar: "جمع تغريدات وزارة الصحة عن الشائعات",
            steps: [
              {
                key: "moh_rumor_tweets",
                platform: "x",
                capability: timelineEp.capability,
                source: { kind: "account", value: "@SaudiMOH" },
                topic: "شائعات",
                count: { total: 20 },
                deliver: true,
                title_ar: "تغريدات نفي الشائعات",
              },
            ],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "tool_choice") {
        return {
          input: {
            options: [
              {
                endpoint_id: timelineEp.id,
                params_json: JSON.stringify({ handle: "SaudiMOH", limit: 20 }),
                cursor_input: "cursor",
                more_params_json: [],
              },
            ],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "field_map") {
        return {
          input: {
            fields: { id: ["id"], text: ["text"] },
            extra: [],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "judge_sample") {
        judgeCount++;
        // All 20 items match
        return { input: { matching_indices: Array.from({ length: 20 }, (_, i) => i) }, costUsd: 0.001 };
      }
      return { input: {}, costUsd: 0.001 };
    });

    const logs: string[] = [];
    const res = await planWithLlm(
      {
        words: ["تغريدات حساب @SaudiMOH عن الشائعات"],
        request: "",
        scoutAllowed: false,
      },
      {
        model: mockModel,
        probe: mockProbe as any,
        readPage: mockReadPage as any,
        catalog: cat,
        access: null,
        today: "2026-11-23",
        log: (msg) => logs.push(msg),
      }
    );

    expect(res.kind).toBe("plan");
    if (res.kind === "plan") {
      expect(res.plan.stages[0].planned_rows).toBe(20);
    }

    // Only 1 page was probed because target (20) was reached on page 1!
    expect(probedCursors).toEqual(["initial"]);
    expect(judgeCount).toBe(1);

    const scanLog = logs.find((l) => l.startsWith("llm_planner_timeline_scan"));
    expect(scanLog).toBeDefined();
    expect(scanLog).toContain("stopped reason=target_reached");
    expect(scanLog).toContain("pages=1");
    expect(scanLog).toContain("examined=20");
    expect(scanLog).toContain("accepted=20");
  });

  it("0 on-topic after budget: probes up to 4 pages and triggers honest shortfall question before any card", async () => {
    let judgeCount = 0;
    const probedCursors: string[] = [];

    const mockProbe = vi.fn(async (endpointId: string, params: Record<string, unknown>) => {
      const cursor = params.cursor as string | undefined;
      probedCursors.push(cursor ?? "initial");
      const pageIndex = probedCursors.length;
      return {
        ok: true,
        call_id: `call_page_${pageIndex}`,
        rows_in_page: 20,
        items: Array.from({ length: 20 }, (_, i) => ({
          id: `p${pageIndex}_t${i + 1}`,
          text: `منشور روتيني غير متعلق بموضوع البحث رقم ${i + 1}`,
        })),
        has_more: true,
        next_cursor: `cursor_page_${pageIndex + 1}`,
        charge_usd: 0.001,
      };
    });

    const mockReadPage = vi.fn(async (callId: string) => ({
      output: {
        data: {
          tweets: Array.from({ length: 20 }, (_, i) => ({
            id: `${callId}_t${i + 1}`,
            text: `منشور روتيني غير متعلق بموضوع البحث رقم ${i + 1}`,
            published_at: new Date(Date.now() - i * 3600 * 1000).toISOString(),
          })),
        },
      },
    }));

    const mockModel: any = vi.fn(async ({ tool }: any) => {
      if (tool?.name === "request_plan") {
        return {
          input: {
            decision: "plan",
            understanding_ar: "جمع تغريدات حساب وزارة الصحة عن الشائعات",
            steps: [
              {
                key: "moh_rumor_tweets",
                platform: "x",
                capability: timelineEp.capability,
                source: { kind: "account", value: "@SaudiMOH" },
                topic: "شائعات",
                count: { total: 20 },
                deliver: true,
                title_ar: "تغريدات نفي الشائعات",
              },
            ],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "tool_choice") {
        return {
          input: {
            options: [
              {
                endpoint_id: timelineEp.id,
                params_json: JSON.stringify({ handle: "SaudiMOH", limit: 20 }),
                cursor_input: "cursor",
                more_params_json: [],
              },
            ],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "field_map") {
        return {
          input: {
            fields: { id: ["id"], text: ["text"] },
            extra: [],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "judge_sample") {
        judgeCount++;
        // 0 matches on all pages
        return { input: { matching_indices: [] }, costUsd: 0.001 };
      }
      if (tool?.name === "scout_question") {
        return {
          input: {
            message_ar: "جرّبنا البحث في ٨٠ تغريدة من @SaudiMOH ولم نجد نتائج متطابقة بالشروط التي كتبتها.",
            options_ar: [
              "سلّمني الموجود فقط",
              "وسّع البحث إلى منصات ومصادر أخرى في الكتالوج",
            ],
          },
          costUsd: 0.001,
        };
      }
      return { input: {}, costUsd: 0.001 };
    });

    const logs: string[] = [];
    const res = await planWithLlm(
      {
        words: ["تغريدات حساب @SaudiMOH عن الشائعات"],
        request: "",
        scoutAllowed: true,
      },
      {
        model: mockModel,
        probe: mockProbe as any,
        readPage: mockReadPage as any,
        catalog: cat,
        access: null,
        today: "2026-11-23",
        log: (msg) => logs.push(msg),
      }
    );

    // Budget guard: capped at <= 4 calls per step
    expect(probedCursors.length).toBe(4);
    expect(judgeCount).toBe(4);

    // Result is a question (shortfall question with widening options), NEVER a false plan card!
    expect(res.kind).toBe("question");
    if (res.kind === "question") {
      expect(res.scout).toBe(true);
      expect(res.question_ar).toContain("٨٠");
      expect(res.options_ar?.length).toBeGreaterThanOrEqual(2);
    }

    const scanLog = logs.find((l) => l.startsWith("llm_planner_timeline_scan"));
    expect(scanLog).toBeDefined();
    expect(scanLog).toContain("stopped reason=budget_reached");
    expect(scanLog).toContain("pages=4");
    expect(scanLog).toContain("examined=80");
    expect(scanLog).toContain("accepted=0");
  });
});
