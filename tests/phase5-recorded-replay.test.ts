import { describe, expect, it } from "vitest";
import calls from "./fixtures/msn-088c-calls.json";
import pages from "./fixtures/msn-088c-pages.json";
import type { Gateway } from "../agent/src/gateway";
import { createSourceGateway } from "../agent/src/engine/sourceGateway";
import { createJobCallBudget } from "../src/lib/server/callBudget";

/**
 * PHASE 5, RECORDED REAL CALLS: the execution calls of the production mission msn_088cfef00f92a8ff1ea9 (13 Nov 2026, read-only from mission_calls: endpoint, page, status and the REAL recorded cost) are
 * replayed through the SourceGateway. What is real: the order, the pages asked for, every call's status and cost, and the contact values the mission delivered. What is simulated: the answer BODY of a call
 * that returned rows other than a delivered value (the recorded row counts are used, the values are not invented: such a row carries no address).
 * It proves on Diger's own real money trail that the gateway dispatches each web id to the web gateway, adds no request and no cost of its own, counts billed EMPTY answers (HTTP 200 is not research) and
 * keeps failed calls visible.
 */
type RecordedCall = { phase: string; endpoint_id: string; status: string; url: string | null; cost_usd: number };
const recorded = (calls as { calls: RecordedCall[] }).calls.filter((c) => c.phase === "execution" && c.endpoint_id.startsWith("contextdev.parse."));
const delivered = (pages as { delivered_contacts: Array<{ email?: string; phone?: string; link: string }> }).delivered_contacts;

describe("Phase 5: msn_088c's recorded Context.dev parser calls through the SourceGateway", () => {
  it("every recorded call goes to the web gateway with its own page, the spend equals the recorded real cost, billed empty answers are counted, failures stay failures", async () => {
    expect(recorded.length).toBeGreaterThan(20);
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const tregCalls: string[] = [];
    const gateway = { async tregCall(i: { endpoint_id?: unknown }) { tregCalls.push(String(i.endpoint_id)); return { ok: false, call_id: "x", refused: "bad_source", message: "" }; } } as unknown as Gateway;
    let n = 0;
    const asked: Array<{ parser: unknown; url: unknown }> = [];
    let cursor = 0;
    // the web gateway answers as it did on 13 Nov: the recorded status and the recorded real cost of the next call
    const parsePage = async (args: { parser?: unknown; url?: unknown }) => {
      const rec = recorded[cursor++];
      asked.push({ parser: args.parser, url: args.url });
      const id = `call_${String((n += 1)).padStart(4, "0")}`;
      budget.settle(0, rec.cost_usd);
      if (rec.status === "failed") return { ok: false as const, call_id: id, failed: true as const, message: "the source answered with an error (recorded)" };
      const value = rec.status === "ok" ? delivered.find((d) => d.link === rec.url || (d.email && rec.url && rec.url.includes(d.email.split("@")[1]))) : undefined;
      const rows = rec.status === "ok" ? [value?.email ? { email: value.email } : {}] : [];
      return { ok: true as const, call_id: id, source: rec.endpoint_id, rows_in_page: rows.length, next_cursor: null, shape: null, first_rows: [], cost_basis: "reported" as const, saved: id };
    };
    const web = { parsePage, webSearch: parsePage, webScrape: parsePage, peopleSearch: parsePage } as any;
    const scope = { contacts: { endpointIds: [...new Set(recorded.map((r) => r.endpoint_id))], capUsd: null } };
    const sg = createSourceGateway({ gateway, web, scope, budget });
    const results = [];
    for (const r of recorded) results.push(await sg.call({ stageKey: "contacts", endpoint_id: r.endpoint_id, params: { url: r.url } }));
    // the gateway made exactly the recorded requests, in order, with each call's own page and parser; nothing went to TREG
    expect(tregCalls).toEqual([]);
    expect(asked.map((a) => a.url)).toEqual(recorded.map((r) => r.url));
    expect(asked.map((a) => `contextdev.parse.${a.parser}`)).toEqual(recorded.map((r) => r.endpoint_id));
    // money: the stage's spend is the recorded real cost, to the micro-dollar, empty and failed calls included
    const realUsd = recorded.reduce((s, r) => s + r.cost_usd, 0);
    expect(sg.stageSpentUsd("contacts")).toBeCloseTo(realUsd, 9);
    expect(budget.spentUsd()).toBeCloseTo(realUsd, 9);
    // outcomes follow the record: a billed EMPTY answer is a successful call with no row (counted in money, never research)
    const empty = recorded.filter((r) => r.status === "empty");
    expect(empty.length).toBeGreaterThan(0);
    expect(empty.every((r) => r.cost_usd > 0)).toBe(true);
    expect(results.filter((r) => r.ok && r.rows_in_page === 0).length).toBe(empty.length);
    expect(sg.records().filter((r) => r.outcome === "failed").length).toBe(recorded.filter((r) => r.status === "failed").length);
    expect(sg.records().every((r) => r.via === "web" && r.provider === "contextdev")).toBe(true);
  });
});
