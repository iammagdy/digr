import { describe, expect, it } from "vitest";
import type { MemoryStore } from "../agent/src/memoryStore";
import { readWorkbook } from "./helpers/agentReplay";
import { runS4, vid } from "./helpers/s4World";
import { isRepliesStage } from "../src/lib/agentMission/replies";

/**
 * S4, the live test of 2026-11-02 10:26 Cairo (docs/S1-LIVE-FINDINGS.md, S4). The exact request «... من مصر، مع كل التعليقات والردود».
 *  1. D7: the customer named a country; the cheapest search had no country input (both videos were Iraqi); a search that can express it wins, even if dearer.
 *  2. The replies stage delivered 0: no comment of the delivered page said it had replies, so no reply was read. Replies are read for every comment that has them.
 *  3. The comments sheet has the comment language column, with Arabic labels, as the videos sheet has.
 */
const run = (o = {}) => runS4(o);
const callsOf = (r: Awaited<ReturnType<typeof run>>) => (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]);

describe("1. the country: a tool that can express it wins over one that cannot", () => {
  it("a plan on the cheapest search (no country input) is refused: the catalog has searches that take the country, named in the refusal", async () => {
    const r = await run();
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    expect(proposals[0].result.ok).toBe(false);
    const text = JSON.stringify(proposals[0].result);
    expect(text).toContain("tikhub.tiktok.search.videos");
    expect(text).toContain("region");
    // the plan on the tool that can express the country is accepted
    expect(proposals[1].result.ok).toBe(true);
  });
  it("the plan's search tool has a country field and the planning call received Egypt", async () => {
    const r = await run();
    const videos = r.plannedPlan.stages[0];
    expect(videos.engine!.endpoint_id).toBe("tikhub.tiktok.search.videos");
    expect(videos.engine!.params.region).toBe("EG");
    expect(callsOf(r).filter((c) => c.endpointId === "tikhub.tiktok.search.videos").every((c) => c.params.region === "EG")).toBe(true);
    expect((videos.engine!.gaps ?? []).some((g) => g.cls === "country")).toBe(false);
  });
  it("the card no longer says the source cannot name the country", async () => {
    const r = await run();
    expect(((r.planView.notesAr ?? []) as string[]).join(" ")).not.toContain("لا يسمح بتحديد البلد");
  });
});

describe("2. the replies are read for every comment that has them", () => {
  it("the comments page gives a counter: 6 + 3 replies are read and delivered", async () => {
    const r = await run();
    expect(r.plannedPlan.stages.some(isRepliesStage)).toBe(true);
    const result = (r.store as MemoryStore).events.find((e) => e.kind === "result")!.counts as Record<string, number>;
    expect(result.stage_3_rows).toBe(9);
  });
  it("the comments page says 0 replies for every comment (an empty counter) while replies exist: every comment is read, and the 9 replies are delivered", async () => {
    const r = await run({ zeroCounters: true });
    const result = (r.store as MemoryStore).events.find((e) => e.kind === "result")!.counts as Record<string, number>;
    expect(result.stage_3_rows).toBe(9);
    expect(callsOf(r).filter((c) => c.endpointId === "anyapi.tiktok.comment_replies").length).toBe(90);
  });
});

describe("3. the comments sheet has the comment language, in Arabic", () => {
  it("a language column «لغة التعليق» with Arabic labels, even when the plan's columns had none", async () => {
    const r = await run({ noLanguage: true });
    const wb = await readWorkbook(r);
    const sheet = wb.worksheets.find((s) => /تعليق/.test(s.name))!;
    const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
    const at = header.indexOf("لغة التعليق");
    expect(at).toBeGreaterThan(0);
    const values = new Set<string>();
    sheet.eachRow((row, n) => { if (n > 1) values.add(String(row.getCell(at).value ?? "")); });
    expect([...values].every((v) => ["العربية", "لغة أخرى", "غير محددة"].includes(v))).toBe(true);
    expect(values.has("العربية")).toBe(true);
  });
  it("the language the source gives is labelled in Arabic (no code in the file)", async () => {
    const r = await run();
    const wb = await readWorkbook(r);
    const sheet = wb.worksheets.find((s) => /تعليق/.test(s.name))!;
    const at = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? "")).indexOf("لغة التعليق");
    expect(at).toBeGreaterThan(0);
    sheet.eachRow((row, n) => { if (n > 1) expect(String(row.getCell(at).value ?? "")).not.toMatch(/^[a-z]{2}$/); });
  });
});

void vid;
