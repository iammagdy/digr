import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserFetch } from "../src/lib/agentMission/stage4/browserFetch";
import { fetchReviewRequest } from "../src/lib/agentMission/stage4/reviewRequestClient";
import { fetchFileWorkflow } from "../src/lib/agentMission/stage4/fileWorkflowClient";

/**
 * LAUNCH ROUND: the browser's own `fetch` refuses to be called with any `this` but the window («Illegal invocation»). The Stage 4 clients call `input.fetchFn(...)`, i.e. with the options object as `this`; passing the global `fetch` itself therefore made every panel say
 * «تعذّر الاتصال الآن» in a real browser without sending a request (found by the first real-browser run). A mock fetch has no such rule, which is why 1,000+ unit tests never saw it. `strictFetch` below enforces the browser's rule.
 */
const ROOT = path.resolve(__dirname, "..");
const strictFetch = function (this: unknown, ..._args: unknown[]): Promise<Response> {
  if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
  return Promise.resolve(new Response(JSON.stringify({ success: true, request: null, workflow: { items: [] } }), { status: 200 }));
};
afterEach(() => vi.unstubAllGlobals());

describe("the Stage 4 panels call fetch the way a browser allows", () => {
  it("the raw global fetch FAILS in the client's call shape (this is the defect), browserFetch does not", async () => {
    vi.stubGlobal("fetch", strictFetch);
    const headers = async () => ({});
    const rawSpy = vi.fn(strictFetch);
    vi.stubGlobal("fetch", rawSpy);
    // the defect: the raw global passed as `fetchFn` never reaches the network (the client answers «null» = nothing waits, the panel says it could not connect)
    const bad = await fetchFileWorkflow({ missionId: "msn_5851abc92a1e6645a9cd", fetchFn: fetch, headers });
    expect(bad.state).not.toBe("ok");
    expect(() => strictFetch.call({})).toThrow(/Illegal invocation/);
    // the real client, with the strict fetch, through browserFetch: it SENDS the request and reads the answer
    const spy = vi.fn(strictFetch);
    vi.stubGlobal("fetch", spy);
    const r = await fetchFileWorkflow({ missionId: "msn_5851abc92a1e6645a9cd", fetchFn: browserFetch, headers });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.state).toBe("ok");
  });
  it("no component passes the global fetch itself as `fetchFn`", () => {
    const dir = path.join(ROOT, "src/components/mission");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/fetchFn:\s*fetch\b/);
  });
});
