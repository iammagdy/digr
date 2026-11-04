import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { readAskEdits } from "../agent/src/stage2/askEdits";
import type { CallRow } from "../agent/src/types";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { askEditPath, askEditsOf, nextAskEditIndex } from "../src/lib/agentMission/stage2/askEditStore";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { replayGateway } from "./helpers/replayGateway";

/**
 * STAGE 2 S2 (docs/STAGE-2.md): the customer's card edits reach the worker's planning. They are kept as create-only objects `ask_edits/eNNNN.json` in the mission's folder; the worker
 * applies them by code after reading the request. A count edit re-plans from the pages ALREADY READ: no new gateway call (stored real pages of M12, msn_5851abc92a1e6645a9cd).
 */
const catalog = loadTregCatalog();
const M12 = "msn_5851abc92a1e6645a9cd";
const REQUEST = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
const mission = (id: string) => ({ id, request_text: REQUEST, answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" });
const NOW = Date.parse("2026-11-02T11:36:00Z");

describe("the edits' folder", () => {
  it("names are create-only and ordered; the next number follows the highest; bodies that are not edits are skipped", () => {
    expect(askEditPath(1)).toBe("ask_edits/e0001.json");
    expect(nextAskEditIndex([])).toBe(1);
    expect(nextAskEditIndex(["ask_edits/e0001.json", "e0007.json", "other.json"])).toBe(8);
    expect(askEditsOf([
      { name: "ask_edits/e0002.json", body: JSON.stringify({ field: "budget", value: 500 }) },
      { name: "ask_edits/e0001.json", body: JSON.stringify({ field: "count", value: 1 }) },
      { name: "ask_edits/e0003.json", body: "{not json" },
      { name: "ask_edits/e0004.json", body: JSON.stringify({ field: "platform", value: "x" }) },
    ])).toEqual([{ field: "count", value: 1 }, { field: "budget", value: 500 }]);
  });
  it("the worker reads them from the store in order; an unreadable folder gives none", async () => {
    const store = createMemoryStore();
    await store.putFile("m", "ask_edits/e0002.json", JSON.stringify({ field: "commentsPerParent", value: 5 }), "application/json");
    await store.putFile("m", "ask_edits/e0001.json", JSON.stringify({ field: "count", value: 1 }), "application/json");
    expect(await readAskEdits(store, "m")).toEqual([{ field: "count", value: 1 }, { field: "commentsPerParent", value: 5 }]);
    expect(await readAskEdits({ listFiles: async () => { throw new Error("down"); }, getFile: async () => null }, "m")).toEqual([]);
  });
});

describe("a card edit reaches the planning, with no new read", () => {
  it("first planning: two videos; the same mission planned again with «count 1» and its earlier calls: one video, and the gateway is asked for NOTHING", async () => {
    const store = createMemoryStore();
    const target = "msn_s2_edit";
    const first = replayGateway(M12, catalog, store, target);
    const one = await planByCompiler({ mission: mission(target), gateway: first.gateway, store, catalog, nowMs: NOW });
    if (one.kind !== "plan") throw new Error(one.kind);
    expect(one.plan.stages[0].planned_rows).toBe(2);
    expect(first.stats.served.length).toBeGreaterThan(0);
    // the calls the first planning made, as the gateway records them (id «<mission>:<call>», the inputs as the digest)
    const priorCalls = first.stats.served.map((c) => ({ id: `${target}:${c.servedAs}`, mission_id: target, phase: "planning", status: "ok", endpoint_id: c.endpointId, params_digest: c.params })) as unknown as CallRow[];
    await store.putFile(target, askEditPath(1), JSON.stringify({ field: "count", value: 1 }), "application/json");
    const askEdits = await readAskEdits(store, target);
    const second = replayGateway(M12, catalog, store, target, { firstSeq: 100 });
    const two = await planByCompiler({ mission: mission(target), gateway: second.gateway, store, catalog, nowMs: NOW, priorCalls, askEdits });
    if (two.kind !== "plan") throw new Error(two.kind);
    expect(two.plan.stages[0].planned_rows).toBe(1);
    expect(two.ask.count).toBe(1);
    expect(second.stats.served).toEqual([]);
    expect(second.stats.unserved).toEqual([]);
    expect(two.plan.price.reservePoints).toBeLessThan(one.plan.price.reservePoints);
  });
  it("no edits: the planning is exactly today's (the same plan with and without an empty list)", async () => {
    const a = createMemoryStore(), b = createMemoryStore();
    const pa = await planByCompiler({ mission: mission("msn_s2_a"), gateway: replayGateway(M12, catalog, a, "msn_s2_a").gateway, store: a, catalog, nowMs: NOW });
    const pb = await planByCompiler({ mission: mission("msn_s2_a"), gateway: replayGateway(M12, catalog, b, "msn_s2_a").gateway, store: b, catalog, nowMs: NOW, askEdits: [] });
    expect(JSON.stringify(pb)).toBe(JSON.stringify(pa));
  });
  it("a refused edit in the folder is skipped by code (the plan is today's)", async () => {
    const a = createMemoryStore(), b = createMemoryStore();
    const pa = await planByCompiler({ mission: mission("msn_s2_b"), gateway: replayGateway(M12, catalog, a, "msn_s2_b").gateway, store: a, catalog, nowMs: NOW });
    const pb = await planByCompiler({ mission: mission("msn_s2_b"), gateway: replayGateway(M12, catalog, b, "msn_s2_b").gateway, store: b, catalog, nowMs: NOW, askEdits: [{ field: "count", value: 0 }] });
    expect(JSON.stringify(pb)).toBe(JSON.stringify(pa));
  });
});

describe("the worker reads the edits only behind DIGER_STAGE2_ASK_CARD", () => {
  it("runMission.ts reads them only when the flag is on for the account", () => {
    const src = readFileSync(new URL("../agent/src/runMission.ts", import.meta.url), "utf8");
    expect(src).toContain('const askEdits = compiledActive && stage2Enabled("DIGER_STAGE2_ASK_CARD", redesign.isTest) ? await readAskEdits(store, mission.id) : [];');
    expect(src).toContain("...(askEdits.length > 0 ? { askEdits } : {})");
  });
});
