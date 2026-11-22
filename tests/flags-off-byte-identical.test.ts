import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertBoundReplay, readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { ENDPOINT, pages, planning } from "./helpers/engineXScenario";
import { FULL_WORLD, LIVE_WORLD, runG4 } from "./helpers/g4RepliesWorld";
import { g1 } from "./helpers/g1World";
import type { MemoryStore } from "../agent/src/memoryStore";
import { isInternalEvent } from "../src/lib/agentMission/eventText";

beforeEach(() => vi.stubEnv("JOB_MAX_POINTS_CAP", ""));
afterEach(() => vi.unstubAllEnvs());

/**
 * S1 PROOF: WITH EVERY FLAG OFF, THE OUTPUT IS BYTE-FOR-BYTE WHAT IT WAS BEFORE THIS PULL REQUEST. Five existing golden worlds (X posts, TikTok videos and comments with replies in two shapes, companies and decision makers in two sectors) are replayed end to end with
 * no flag set; everything the customer or the ledger could see is written down in a normalised form and hashed, section by section: the mission's fields and stored plan, every cell of the workbook, the plan card and the final card, the notices, the customer-visible events,
 * the sequence of provider calls with their inputs and the sequence of money calls. The pinned digests in tests/fixtures/flags-off-digests.json were produced by running THIS SAME FILE on `origin/main` (the code before this pull request). The internal events (the planning
 * telemetry of item 0.4, the pipeline note) are admin-only and are not part of the customer-visible output; they are the one thing that differs and they are excluded here by the same function the customer API uses (isInternalEvent).
 * To regenerate (only ever on the base commit): WRITE_FLAGS_OFF_DIGESTS=1 npx vitest run tests/flags-off-byte-identical.test.ts
 */
// ROUND 26 CHANGED: the planView and finalView digests of the five worlds were re-pinned for the customer-view changes of round 26 (steps checked in order, one counter, the collecting
// sentence, the time of the last event); every other section (mission and plan, workbook, notices, events, provider calls, ledger) is byte-identical to the base commit 0bf7b2c.
// ROUND 57 CHANGED: the planView and finalView digests of the five worlds were re-pinned for the card's new price explanation (`priceExplainAr`: each step's count and the hold as price + margin); every other section
// (mission and plan, workbook, notices, events, provider calls, ledger) was compared section by section and is byte-identical to main e71769d.
// ROUND 58 CHANGED: planView and finalView of the five worlds (the card's new `headlineCountAr` and `countLinesAr`, and the price explanation saying the priced total is items, not companies), and the workbook of
// g1_electromechanical / g2_petroleum (the first sheet's delivery sentence adds «منها ٥ شركات، و١٠ من «موظفو كل شركة».»); mission and plan, notices, events, provider calls and ledger are byte-identical to main 196942d.
// ROUND 59 CHANGED: only the `workbook` digests of g1 and g2 (company worlds) were re-pinned: the company check (src/lib/agentMission/companyQuality.ts) adds lines to the summary's «حدود هذا التسليم» (no source link per record;
// identity consistency checked without visiting the sites). mission, plan, ledger, notices, planView and providerCalls are unchanged.
// CHANGED (S1 live fixes): the pinned digests include cells that carry today's date in Cairo time, so this file failed on plain `origin/main` as soon as the Cairo day changed (observed 2026-11-02 00:21 Cairo). Only `Date` is pinned, to the day the digests were produced (2026-11-01).
// CARD REDESIGN PHASE 2 CHANGED (16 Nov 2026): only the `planView` and `finalView` digests of the five worlds were re-pinned: the customer view gained `requestPartsAr` (empty for these worlds, which are not LLM-planned); mission and plan, workbook, notices, events, provider calls and ledger are byte-identical (checked section by section).
// D-0117 CHANGED (DT-20261119-06 PART B, Megz's decision: a delivered person is charged only if a contact the customer asked for reached the file): only the g1_electromechanical and g2_petroleum digests of `mission`, `finalView`, `notices`, `events` and `ledger` were re-pinned: in these worlds the finders find nothing, so the 10 people are delivered but not charged (charge 2,234 -> 745, delivered units for the charge 15 -> 5, one new customer line about the people not charged); the workbook, the plan card, the provider calls and the other three worlds are byte-identical.
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-01T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
// LIVE CHECK 16 NOV 2026 CHANGED: only the `planView` and `finalView` digests of the five worlds were re-pinned: the customer view gained `fileRowsAr` (what the delivered file holds, shown on the file button), and counts of 100 and above follow the last two digits (g4 also re-pinned `workbook` for that wording).
// DT-20261118-03 CHANGED (Megz D-0084, D-0085): every section of g1_electromechanical / g2_petroleum was re-pinned, compared section by section with the commit before: the person rows no longer carry the company's number as
// their phone (8 of 10 «رقم الشركة» before, 0 now in these fake worlds, whose answers hold no personal number), the person-phone chain is blitz, aiark, tomba up to 0.05 USD a call (no company-number search and no validator call for it),
// and the price follows (hold 1,341 -> 2,569, charge 1,166 -> 2,234 points for the same 15 rows). The three other worlds are unchanged.
// DT-20261119-07 B: the two people worlds store e-mail alternates and test the second pass; the workbook has unavailable contact cells.
// DT-20261119-13 CHANGED (D-0133, D-0134, D-0140, C1-C7): only the `notices` digests of the five worlds were re-pinned: bounded <=45 status subjects, real stage nouns, and single-placement money in detail1. All other sections byte-identical.
// DT-20261120-emails CHANGED: only the `notices` digests of the five worlds were re-pinned (unit noun from catalog capability, one-sentence failure lead, title prefix fix); every other section is byte-identical to main.
// DT-20261121-audit/FX-02 CHANGED: only `g4_live_world.finalView` and `g4_full_world.finalView` were re-pinned for N4 partial shortage reason & refund line; `planView`, all non-partial sections, and the other three worlds are byte-identical to main.
// g1_electromechanical: FX-01B: card names the requested role + fallback clause
// g2_petroleum: FX-01B: card names the requested role + fallback clause
// Only mission, providerCalls and workbook are re-pinned for those worlds. The existing ledger, planView, finalView, notices and visible event hashes still apply.
const FIXTURE = path.join(__dirname, "fixtures", "flags-off-digests.json");
const DROP = new Set(["created_at", "updated_at", "lease_until", "started_at", "finished_at", "generated_at", "at", "ts", "beat_at", "created", "startedAt", "p_quote_hash", "p_expires_at", "expires_at"]);
const norm = (value: unknown): string => JSON.stringify(value, (k, v) => {
  if (DROP.has(k) || /(_hash$|_ms(_|$))/.test(k)) return undefined;
  if (typeof v === "string") return v.replace(/msn_[a-z0-9]+/g, "msn_X").replace(/(job_quote|quote|res|rel|chg|top)_[A-Za-z0-9_-]{6,}/g, "$1_X").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "TS");
  return v;
});
const hash = (value: unknown): string => createHash("sha256").update(norm(value)).digest("hex").slice(0, 16);

type ApprovalViewFields = { approvalState?: string; approvalVersion?: unknown };
type ReplayPlanView = ReplayResult["planView"] & ApprovalViewFields;

function legacyViewOf(view: ReplayPlanView) {
  const { approvalState: _approvalState, approvalVersion: _approvalVersion, ...legacyFields } = view;
  return legacyFields;
}

function legacyPlanViewOf(view: ReplayPlanView & { affordability?: unknown }) {
  const { affordability: _affordability, ...legacyFields } = view;
  return legacyViewOf(legacyFields);
}

const LEGACY_ACCEPT_ARGUMENTS = ["p_quote_id", "p_user_id", "p_expected_quote_hash"];

function preserveAcceptArgumentOrder(call: ReplayResult["money"]["calls"][number]) {
  if (call.name !== "accept_quote_atomic") return call;
  const keys = Object.keys(call.args);
  const ordered = LEGACY_ACCEPT_ARGUMENTS.filter((key) => keys.includes(key));
  const extra = keys.filter((key) => !ordered.includes(key));
  return { ...call, args: Object.fromEntries([...ordered, ...extra].map((key) => [key, call.args[key]])) };
}

async function sectionsOf(r: ReplayResult): Promise<Record<string, string>> {
  const wb = await readWorkbook(r);
  const sheets = wb.worksheets.map((ws) => ({ name: ws.name, rows: Array.from({ length: ws.rowCount }, (_, i) => (ws.getRow(i + 1).values as unknown[]).slice(1).map((c) => (c && typeof c === "object" && "text" in (c as object) ? { text: (c as { text: unknown }).text, link: (c as { hyperlink?: unknown }).hyperlink } : c))) }));
  const m = r.mission;
  const visibleEvents = r.store.events.filter((e) => !isInternalEvent(e)).map((e) => ({ kind: e.kind, message_ar: e.message_ar, counts: e.counts ?? {} }));
  return {
    mission: hash({ status: m.status, delivered: m.delivered_units, charged: m.charged_points, reserved: m.reserved_points, unit: m.unit_price_points, summary: m.summary_ar, plan: m.plan }),
    workbook: hash(sheets),
    planView: hash(legacyPlanViewOf(r.planView)),
    finalView: hash(legacyViewOf(r.finalView)),
    notices: hash(r.notices),
    events: hash(visibleEvents),
    providerCalls: hash(r.call.mock.calls.map((c) => [(c[0] as { endpointId: string }).endpointId, (c[0] as { params: unknown }).params])),
    ledger: hash(r.money.legacyMoneyTrace().map(preserveAcceptArgumentOrder)),
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
      const result = await make();
      assertBoundReplay(result);
      if (name === "g1_electromechanical" || name === "g2_petroleum") {
        const people = (await readWorkbook(result)).worksheets[2];
        const header = people.getRow(1).values as string[];
        for (const title of ["إيميل المسؤول المباشر", "هاتف / محمول المسؤول"]) {
          const col = header.indexOf(title);
          expect(col).toBeGreaterThan(0);
          const values = Array.from({ length: people.rowCount - 1 }, (_, i) => people.getRow(i + 2).getCell(col).value);
          expect(values.every((value) => value === null || value === "غير متوفر")).toBe(true);
        }
      }
      expect(result.planView).toMatchObject({
        approvalState: "unapproved",
        approvalVersion: { updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), planHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      });
      expect(result.planView).toHaveProperty("affordability", expect.objectContaining({
        mode: "ready", availablePoints: result.initialBalance, reservePoints: result.plannedPlan.price.reservePoints,
      }));
      expect(result.planView).not.toHaveProperty("affordability.offer");
      expect(result.finalView).not.toHaveProperty("affordability");
      expect(result.finalView).toHaveProperty("approvalState", "confirmed");
      expect(result.finalView).not.toHaveProperty("approvalVersion");
      const sections = await sectionsOf(result);
      collected[name] = sections;
      if (writing) { mkdirSync(path.dirname(FIXTURE), { recursive: true }); writeFileSync(FIXTURE, JSON.stringify({ ...(existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf-8")) : {}), [name]: sections }, null, 1)); return; }
      expect(pinned[name], `no pinned digest for ${name}`).toBeDefined();
      expect(sections).toEqual(pinned[name]);
      if (name === "x_posts_300") {
        const changed = { ...result.planView, currentLineAr: `${result.planView.currentLineAr} تغيّر النص.` };
        expect(hash(legacyPlanViewOf(changed))).not.toBe(pinned[name].planView);
      }
    });
  }
  it("the pinned file covers exactly the five worlds", () => {
    if (writing) return;
    expect(Object.keys(pinned).sort()).toEqual(Object.keys(SCENARIOS).sort());
  });
});
void ENDPOINT;
