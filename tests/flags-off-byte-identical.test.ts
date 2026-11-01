import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { ENDPOINT, pages, planning } from "./helpers/engineXScenario";
import { FULL_WORLD, LIVE_WORLD, runG4 } from "./helpers/g4RepliesWorld";
import { g1 } from "./helpers/g1World";
import type { MemoryStore } from "../agent/src/memoryStore";
import { isInternalEvent } from "../src/lib/agentMission/eventText";

/**
 * S1 PROOF: WITH EVERY FLAG OFF, THE OUTPUT IS BYTE-FOR-BYTE WHAT IT WAS BEFORE THIS PULL REQUEST. Five existing golden worlds (X posts, TikTok videos and comments with replies in two shapes, companies and decision makers in two sectors) are replayed end to end with
 * no flag set; everything the customer or the ledger could see is written down in a normalised form and hashed, section by section: the mission's fields and stored plan, every cell of the workbook, the plan card and the final card, the notices, the customer-visible events,
 * the sequence of provider calls with their inputs and the sequence of money calls. The pinned digests in tests/fixtures/flags-off-digests.json were produced by running THIS SAME FILE on `origin/main` (the code before this pull request). The internal events (the planning
 * telemetry of item 0.4, the pipeline note) are admin-only and are not part of the customer-visible output; they are the one thing that differs and they are excluded here by the same function the customer API uses (isInternalEvent).
 * To regenerate (only ever on the base commit): WRITE_FLAGS_OFF_DIGESTS=1 npx vitest run tests/flags-off-byte-identical.test.ts
 */
// CHANGED (S1 live fixes): the pinned digests include cells that carry today's date in Cairo time, so this file failed on plain `origin/main` as soon as the Cairo day changed (observed 2026-11-02 00:21 Cairo). Only `Date` is pinned, to the day the digests were produced (2026-11-01).
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-01T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const FIXTURE = path.join(__dirname, "fixtures", "flags-off-digests.json");
const DROP = new Set(["created_at", "updated_at", "lease_until", "started_at", "finished_at", "generated_at", "at", "ts", "beat_at", "created", "startedAt", "p_quote_hash", "p_expires_at", "expires_at"]);
const norm = (value: unknown): string => JSON.stringify(value, (k, v) => {
  if (DROP.has(k) || /(_hash$|_ms(_|$))/.test(k)) return undefined;
  if (typeof v === "string") return v.replace(/msn_[a-z0-9]+/g, "msn_X").replace(/(job_quote|quote|res|rel|chg|top)_[A-Za-z0-9_-]{6,}/g, "$1_X").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "TS");
  return v;
});
const hash = (value: unknown): string => createHash("sha256").update(norm(value)).digest("hex").slice(0, 16);

async function sectionsOf(r: ReplayResult): Promise<Record<string, string>> {
  const wb = await readWorkbook(r);
  const sheets = wb.worksheets.map((ws) => ({ name: ws.name, rows: Array.from({ length: ws.rowCount }, (_, i) => (ws.getRow(i + 1).values as unknown[]).slice(1).map((c) => (c && typeof c === "object" && "text" in (c as object) ? { text: (c as { text: unknown }).text, link: (c as { hyperlink?: unknown }).hyperlink } : c))) }));
  const m = r.mission;
  const visibleEvents = r.store.events.filter((e) => !isInternalEvent(e)).map((e) => ({ kind: e.kind, message_ar: e.message_ar, counts: e.counts ?? {} }));
  return {
    mission: hash({ status: m.status, delivered: m.delivered_units, charged: m.charged_points, reserved: m.reserved_points, unit: m.unit_price_points, summary: m.summary_ar, plan: m.plan }),
    workbook: hash(sheets),
    planView: hash(r.planView),
    finalView: hash(r.finalView),
    notices: hash(r.notices),
    events: hash(visibleEvents),
    providerCalls: hash(r.call.mock.calls.map((c) => [(c[0] as { endpointId: string }).endpointId, (c[0] as { params: unknown }).params])),
    ledger: hash(r.money.calls),
  };
}

const SCENARIOS: Record<string, () => Promise<ReplayResult>> = {
  x_posts_300: () => replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)] }),
  g4_live_world: () => runG4(LIVE_WORLD),
  g4_full_world: () => runG4(FULL_WORLD),
  g1_electromechanical: () => g1({}),
  g2_petroleum: () => g1({ sector: "petroleum" }),
};

describe("every flag off: byte-identical to the code before this pull request", () => {
  const writing = process.env.WRITE_FLAGS_OFF_DIGESTS === "1";
  const pinned: Record<string, Record<string, string>> = !writing && existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf-8")) : {};
  const collected: Record<string, Record<string, string>> = {};
  for (const [name, make] of Object.entries(SCENARIOS)) {
    it(`${name}`, async () => {
      const sections = await sectionsOf(await make());
      collected[name] = sections;
      if (writing) { mkdirSync(path.dirname(FIXTURE), { recursive: true }); writeFileSync(FIXTURE, JSON.stringify({ ...(existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf-8")) : {}), [name]: sections }, null, 1)); return; }
      expect(pinned[name], `no pinned digest for ${name}`).toBeDefined();
      expect(sections).toEqual(pinned[name]);
    });
  }
  it("the digest is sensitive: the same X world with the flag ON gives a different workbook and plan (so a pass above means something)", async () => {
    if (writing) return;
    const r = await replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)], deps: (d) => { (d.store as MemoryStore).settings.redesign_flags = { social_posts: "on" }; return d; } });
    const on = await sectionsOf(r);
    expect(on.workbook).not.toBe(pinned.x_posts_300.workbook);
    expect(on.mission).not.toBe(pinned.x_posts_300.mission);
  });
  it("the pinned file covers exactly the five worlds", () => {
    if (writing) return;
    expect(Object.keys(pinned).sort()).toEqual(Object.keys(SCENARIOS).sort());
  });
});
void ENDPOINT;
