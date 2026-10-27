import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { ContentBlock } from "../../src/lib/modelPlanner/transport";

/** What the planner tests share: a gateway that answers from fixtures (and counts the requests), and short builders for the recorded model's tool calls. */
export const fixturePages = (name: string): any[] => JSON.parse(readFileSync(`tests/fixtures/replay/${name}.json`, "utf-8")).pages;

export interface GatewayStub { calls: Array<{ endpointId: string; body: any }>; restore(): void }

/** Replaces `fetch`: a request to /call/<endpoint> is answered from `answers[endpoint]` (a body or a function of the n-th call) with a cost header; anything else is a failure. */
export function stubGateway(answers: Record<string, any | ((n: number, body: any) => any)>, costMicro: Record<string, number> = {}): GatewayStub {
  const calls: GatewayStub["calls"] = [];
  const seen = new Map<string, number>();
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    const m = /\/call\/([^/?#]+)/.exec(String(url));
    if (!m) return new Response(JSON.stringify({ error: "refused" }), { status: 404 });
    const endpointId = decodeURIComponent(m[1]);
    let body: any = {};
    try { body = init?.body ? JSON.parse(init.body) : Object.fromEntries(new URL(String(url)).searchParams); } catch { body = {}; }
    calls.push({ endpointId, body });
    const n = (seen.get(endpointId) ?? 0) + 1;
    seen.set(endpointId, n);
    const answer = answers[endpointId];
    if (answer === undefined) return new Response(JSON.stringify({ error: "no_fixture" }), { status: 404 });
    const payload = typeof answer === "function" ? answer(n, body) : answer;
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "x-treg-cost-micro": String(costMicro[endpointId] ?? 500), "x-treg-call-id": `stub_${calls.length}` } });
  }));
  return { calls, restore: () => vi.unstubAllGlobals() };
}

let counter = 0;
const id = () => `toolu_${++counter}`;
export const use = (name: string, input: Record<string, unknown>): ContentBlock => ({ type: "tool_use", id: id(), name, input });
export const say = (text: string): ContentBlock => ({ type: "text", text });
export const search = (platform: string | undefined, words: string[]) => [use("catalog_search", { ...(platform ? { platform } : {}), words })];
export const describe = (endpointId: string) => [use("describe_endpoint", { id: endpointId })];
export const sample = (endpointId: string, params: Array<Record<string, unknown>>, limit?: number) => [use("sample_call", { id: endpointId, params, ...(limit ? { limit } : {}) })];
/** The recorded model's plan. Recordings made before the «cheapest suitable first» rule carry no reason for their choice, so the kit adds one (the rule itself is tested with `use("propose_plan", …)` directly). */
export const propose = (input: Record<string, unknown>) => [use("propose_plan", { whyNotCheapest: "recorded plan: this is the endpoint the recording sampled", ...input })];

/** The recorded plan of the X account request, with a few overrides. */
export const xAccountPlan = (over: Record<string, unknown> = {}) => ({
  summaryAr: "جمع ١٠ منشورات من حساب @elonmusk",
  steps: [{
    endpointId: "anyapi.x.user.posts", volume: 10,
    params: [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }],
    fieldMap: { columns: [{ field: "text", headerAr: "نص المنشور", role: "text" }, { field: "authorHandle", headerAr: "الحساب", role: "author_handle" }, { field: "createdUtc", headerAr: "تاريخ النشر", role: "date" }, { field: "likes", headerAr: "الإعجابات", role: "likes", transform: "number" }, { field: "url", headerAr: "الرابط", role: "url" }], pagination: { kind: "token", param: "cursor" } },
    filters: [{ kind: "author_equals", field: "authorHandle", value: "elonmusk", quote: "@elonmusk" }, { kind: "exclude_true", field: "isReply" }, { kind: "exclude_prefix", field: "text", prefix: "RT @" }],
  }],
  ...over,
});
export const X_REQUEST = "أريد ١٠ منشورات من حساب @elonmusk على منصة X";
