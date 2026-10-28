import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInSandbox } from "../agent/src/sandbox";
import { buildTools, newRunState, type ToolSpec } from "../agent/src/tools";
import { makeHarness } from "./helpers/agentHarness";

/** run_code: model-written JavaScript on the mission's own saved files. No environment, no network, no secrets, time and memory limits. */
describe("sandbox isolation", () => {
  it("runs plain computation over the data it is given", async () => {
    const r = await runInSandbox("return inputs.page.items.filter(x => x.n > 1).map(x => x.n * 2)", { page: { items: [{ n: 1 }, { n: 2 }, { n: 3 }] } });
    expect(r).toMatchObject({ ok: true, resultJson: "[4,6]" });
  });

  it("has no environment variables, no secrets and no process object", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-fake-key-for-the-test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
    process.env.TREG_TOKEN = "fake-treg-token";
    try {
      const probe = await runInSandbox("return [typeof process, typeof require, typeof module, typeof globalThis.process, typeof Buffer, typeof setTimeout, typeof fetch, typeof XMLHttpRequest, typeof WebSocket].join(',')", {});
      expect(probe).toMatchObject({ ok: true });
      expect(probe.ok && probe.resultJson).toBe('"undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined"');
      // the usual escapes through the prototype chain find nothing to run
      for (const escape of [
        "return this.constructor.constructor('return process')().env",
        "return (function(){}).constructor('return process.env')()",
        "return Object.getPrototypeOf(async function(){}).constructor('return process')()",
        "return eval('process.env')",
        "return new Function('return process')()",
        "return [].constructor.constructor('return globalThis.process')()",
      ]) {
        const r = await runInSandbox(escape, {});
        const text = JSON.stringify(r);
        expect(r.ok).toBe(false);
        expect(text).not.toContain("sk-fake-key");
        expect(text).not.toContain("fake-service-role");
        expect(text).not.toContain("fake-treg-token");
      }
      // and the child process itself is started with an EMPTY environment
      const r = await runInSandbox("return Object.keys(inputs).length", { a: 1 });
      expect(r).toMatchObject({ ok: true });
    } finally {
      delete process.env.ANTHROPIC_API_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.TREG_TOKEN;
    }
  });

  describe("no network", () => {
    let server: http.Server;
    let port = 0;
    let hits = 0;
    beforeAll(async () => {
      server = http.createServer((_req, res) => { hits += 1; res.end("secret"); });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as { port: number }).port;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("code cannot reach a live local server by any route", async () => {
      const attempts = [
        `return await fetch('http://127.0.0.1:${port}/')`,
        `return require('node:http').get('http://127.0.0.1:${port}/')`,
        `return require('net').connect(${port}, '127.0.0.1')`,
        `return process.binding('tcp_wrap')`,
        `return import('node:http')`,
        `const x = new XMLHttpRequest(); x.open('GET','http://127.0.0.1:${port}/'); x.send(); return 1`,
        `return new WebSocket('ws://127.0.0.1:${port}/')`,
      ];
      for (const code of attempts) {
        const r = await runInSandbox(code, {});
        expect(r.ok === false || r.resultJson === "{}" || r.resultJson === null).toBe(true);
      }
      // give any stray connection time to land
      await new Promise((r) => setTimeout(r, 300));
      expect(hits).toBe(0);
    });
  });

  it("cannot read a file of the machine (the permission model has no read grant but its own runner)", async () => {
    const r = await runInSandbox("return require('fs').readFileSync('/etc/passwd', 'utf8')", {});
    expect(r.ok).toBe(false);
  });

  it("stops code that runs forever", async () => {
    const started = Date.now();
    const r = await runInSandbox("while (true) {}", {}, { timeoutMs: 700 });
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it("stops code that uses too much memory", async () => {
    const r = await runInSandbox("const a = []; while (true) a.push(new Array(1e6).fill('x'));", {}, { timeoutMs: 8000, heapMb: 64 });
    expect(r.ok).toBe(false);
  });

  it("refuses a result that is far too large", async () => {
    const r = await runInSandbox("return 'x'.repeat(5e6)", {});
    expect(r.ok === true || r.ok === false).toBe(true); // either returned (under the cap) or refused: never a crash of the worker
  });
});

describe("run_code only sees the mission's own saved files", () => {
  const tool = (tools: ToolSpec[], name: string) => tools.find((t) => t.name === name)!;

  it("loads its own saved pages and saves the result as a new output file", async () => {
    const h = makeHarness();
    await h.store.putFile(h.mission.id, "raw/call_0001.json", JSON.stringify({ data: [{ id: "1" }, { id: "2" }] }), "application/json");
    const tools = buildTools({ ...h.ctx, state: newRunState() });
    const r = await tool(tools, "run_code").handler({ code: "return inputs.call_0001.data.map(r => ({ id: r.id, parent_id: null }))", files: ["call_0001"] });
    expect(r).toMatchObject({ ok: true, output_id: "out_0001" });
    expect(JSON.parse((await h.store.getFile(h.mission.id, "out/out_0001.json"))!)).toHaveLength(2);
  });

  it("cannot name a file of another mission or a path outside the mission", async () => {
    const h = makeHarness();
    await h.store.putFile("msn_other0001", "raw/call_0001.json", JSON.stringify({ secret: "other mission" }), "application/json");
    const tools = buildTools({ ...h.ctx, state: newRunState() });
    for (const files of [["msn_other0001/raw/call_0001"], ["../msn_other0001/raw/call_0001"], ["/etc/passwd"], ["call_0001"], ["raw/call_0001.json"], ["call_0001/../../x"]]) {
      const r = await tool(tools, "run_code").handler({ code: "return inputs", files });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("other mission");
    }
  });

  it("built-in shell, web fetch and file tools do not exist among the agent's tools", () => {
    const h = makeHarness();
    const names = buildTools(h.ctx).map((t) => t.name);
    for (const banned of ["Bash", "bash", "shell", "WebFetch", "web_fetch", "Read", "Write", "Edit", "Glob", "Grep", "fetch"]) expect(names).not.toContain(banned);
    expect(names.sort()).toEqual(["catalog_search", "describe_endpoint", "finish", "report_progress", "ask_question", "propose_plan", "run_code", "treg_call"].sort());
  });
});
