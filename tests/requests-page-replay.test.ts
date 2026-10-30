import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient } from "./helpers/agentMoney";

const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => state.client, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => (state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) })) };
});

import { GET as listRequests } from "../src/app/api/requests/route";
import { GET as listOpen } from "../src/app/api/missions/route";
import { POST as missionAction } from "../src/app/api/missions/[id]/route";
import { cancelForCustomer } from "../src/lib/agentMission/customerActions";
import { listOpenMissions } from "../src/lib/agentMission/openMissions";
import { buildRequestIndex } from "../src/lib/requests/buildIndex";
import { EXPIRED_SENTENCE_AR, PENDING_MAX_WAITING, PENDING_WINDOW_MS, missionsToExpire } from "../src/lib/requests/expiry";
import { customerFormatsOf } from "../src/lib/requests/files";
import { pendingBlockView } from "../src/lib/requests/pendingBlock";
import { matchesSearch, normalizeSearchText, searchTerms } from "../src/lib/requests/search";
import { REQUEST_TAB_IDS, REQUESTS_PAGE_SIZE, hashOfTab, tabFromHash, type RequestTab } from "../src/lib/requests/tabs";
import OpenMissionsList from "../src/components/mission/OpenMissionsList";
import { getJobIdForQuote } from "../src/lib/md5";

const ME = "u-1";
// the day of the live check; no test reads the real clock
const NOW = Date.parse("2026-10-30T17:30:00Z");
const HOUR = 3600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
let db: MemoryDb;
let money: ReturnType<typeof fakeMoneyClient>;
const clientOf = (d: MemoryDb) => { money = fakeMoneyClient(); const client: any = { from: (t: string) => d.from(t), rpc: money.client.rpc }; return client; };
const mission = (id: string, status: string, createdAt: string, over: Record<string, unknown> = {}) => ({ id: `msn_${id}`, user_id: ME, status, request_text: `طلب ${id}`, created_at: createdAt, updated_at: createdAt, lease_until: null, job_id: null, summary_ar: null, error: null, ...over });
const job = (id: string, status: string, createdAt: string, over: Record<string, unknown> = {}) => ({ id, user_id: ME, status, delivered_units: status === "completed" ? 10 : 0, target_volume_max: 10, created_at: createdAt, ...over });
const index = (tab: RequestTab, over: Record<string, unknown> = {}) => buildRequestIndex(state.client, { userId: ME, tab, now: NOW, ...over });

/** The live state of the tester's «مهام قيد الإعداد» (ids and times as read from the database on 2026-10-30): 8 plans and 3 questions, all waiting, none approved. */
const LIVE_WAITING: Array<[string, string, string, string]> = [
  ["61f9f496279cacccc067", "needs_input", "2026-10-30T01:43:20Z", "عايز ٥ حاجات عن السياحة"],
  ["cc494158fa9f27ff1ab7", "needs_input", "2026-10-30T01:29:12Z", "عايز بيانات عن السوق المصري"],
  ["ef4e18c482568a1ec1ac", "plan_ready", "2026-10-30T01:09:12Z", "عايز ٥ وظائف عن بعد في مجال البرمجة"],
  ["303d88d87f3aef7f95c6", "plan_ready", "2026-10-30T01:06:46Z", "عايز ٣ منتجات عطور من متاجر شوبيفاي"],
  ["878bfdae9fdb57c69674", "plan_ready", "2026-10-30T01:05:46Z", "عايز أول ٣ نتايج بحث جوجل عن السياحة"],
  ["5059162d3a586a55eb36", "plan_ready", "2026-10-30T01:01:23Z", "عايز ٣ حسابات تيك توك عن الطبخ المصري"],
  ["0dd51aa74efc716c95ad", "plan_ready", "2026-10-30T00:59:41Z", "عايز ٥ تعليقات من فيديو يوتيوب"],
  ["25fb87d4b0dd80c6ae12", "plan_ready", "2026-10-29T19:49:50Z", "هات ٥ فيديوهات من فيسبوك عن منتخب مصر"],
  ["cb5fb577dcafdf3b1f16", "plan_ready", "2026-10-29T08:09:30Z", "عايز ١٠ شركات مقاولات في مصر"],
  ["4b08aab1dfe4b5d5b8ee", "needs_input", "2026-10-28T18:03:15Z", "استخرج لي بيانات حساب عام على تيك توك"],
  ["480a44f90e1784edbc94", "plan_ready", "2026-10-28T16:57:36Z", "هات ٣٠٠ تغريدة عن محمد صلاح"],
];
const seedLive = () => db.seed("missions", LIVE_WAITING.map(([id, status, created, text]) => mission(id, status, created, { request_text: text })));

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }); db = createMemoryDb(); state.client = clientOf(db); state.viewer = { userId: ME, isGuest: false, emailVerified: true }; });
afterEach(() => { vi.useRealTimers(); });

describe("1. the pending block: only what truly waits, last 72 hours, newest first, at most 5 (replay of the live state)", () => {
  it("11 waiting missions (8 plans, 3 questions) leave the newest 5; the 6 oldest are expired, with no money touched", async () => {
    seedLive();
    db.seed("credit_ledger", []);
    const idx = await index("all");
    expect(idx.pending.map((p) => p.id)).toEqual(["msn_61f9f496279cacccc067", "msn_cc494158fa9f27ff1ab7", "msn_ef4e18c482568a1ec1ac", "msn_303d88d87f3aef7f95c6", "msn_878bfdae9fdb57c69674"]);
    expect(idx.pending).toHaveLength(PENDING_MAX_WAITING);
    const expired = db.rows("missions").filter((m) => m.summary_ar === EXPIRED_SENTENCE_AR).map((m) => m.id).sort();
    expect(expired).toEqual(["msn_0dd51aa74efc716c95ad", "msn_25fb87d4b0dd80c6ae12", "msn_480a44f90e1784edbc94", "msn_4b08aab1dfe4b5d5b8ee", "msn_5059162d3a586a55eb36", "msn_cb5fb577dcafdf3b1f16"]);
    for (const m of db.rows("missions").filter((x) => expired.includes(x.id))) expect(m).toMatchObject({ status: "cancelled", job_id: null });
    expect(money.calls).toHaveLength(0);
    expect(db.rows("credit_ledger")).toHaveLength(0);
    expect(db.rows("jobs")).toHaveLength(0);
  });

  it("the expired ones show under «فشلت أو أُلغيت» with «انتهت صلاحية الخطة», newest first", async () => {
    seedLive();
    const ended = await index("ended");
    expect(ended.counts.ended).toBe(6);
    expect(ended.rows.map((r) => r.id)).toEqual(["msn_5059162d3a586a55eb36", "msn_0dd51aa74efc716c95ad", "msn_25fb87d4b0dd80c6ae12", "msn_cb5fb577dcafdf3b1f16", "msn_4b08aab1dfe4b5d5b8ee", "msn_480a44f90e1784edbc94"]);
    for (const r of ended.rows) expect(r).toMatchObject({ type: "mission", tab: "ended", endedKind: "expired" });
    for (const r of ended.rows) expect(r.type === "mission" && r.noteAr).toContain(EXPIRED_SENTENCE_AR);
    expect(ended.pending).toEqual([]);
  });

  it("older than 72 hours expires whatever the count: a plan at 73 h and a question at 80 h go; a plan at 71 h stays; repeating changes nothing", async () => {
    db.seed("missions", [mission("p73", "plan_ready", ago(73 * HOUR)), mission("q80", "needs_input", ago(80 * HOUR)), mission("p71", "plan_ready", ago(71 * HOUR))]);
    expect(PENDING_WINDOW_MS).toBe(72 * HOUR);
    expect(missionsToExpire(db.rows("missions"), NOW).map((e) => [e.id, e.reason]).sort()).toEqual([["msn_p73", "age"], ["msn_q80", "age"]]);
    const first = await index("all");
    expect(first.pending.map((p) => p.id)).toEqual(["msn_p71"]);
    const snapshot = JSON.stringify(db.rows("missions"));
    await index("all");
    expect(JSON.stringify(db.rows("missions"))).toBe(snapshot);
    expect(db.rows("missions").find((m) => m.id === "msn_p73")).toMatchObject({ status: "cancelled", summary_ar: EXPIRED_SENTENCE_AR });
  });

  it("a mission the worker holds (queued or planning), an approved one and one with a job are never expired", async () => {
    db.seed("missions", [mission("w", "queued", ago(100 * HOUR)), mission("pl", "planning", ago(100 * HOUR), { lease_until: ago(-60_000) }), mission("ap", "approved", ago(100 * HOUR), { job_id: "job_x" }), mission("wj", "plan_ready", ago(100 * HOUR), { job_id: "job_y" })]);
    await index("all");
    expect(db.rows("missions").map((m) => m.status)).toEqual(["queued", "planning", "approved", "plan_ready"]);
  });

  it("the open list the limiter reads (listOpenMissions, GET /api/missions) applies the same rule", async () => {
    seedLive();
    const list = await listOpenMissions(state.client, { userId: ME, now: NOW });
    expect(list).toHaveLength(5);
    expect(list.map((v) => v.id)[0]).toBe("msn_61f9f496279cacccc067");
    const res = await listOpen(new NextRequest("http://localhost/api/missions"));
    expect((await res.json()).missions).toHaveLength(5);
  });
});

describe("2. «إلغاء» persists, through the existing code path, and touches no money", () => {
  it("cancelling a plan (the live case) moves it to cancelled; after a reload it is out of the block and listed under «فشلت أو أُلغيت»", async () => {
    seedLive();
    db.seed("credit_ledger", []);
    const id = "msn_ef4e18c482568a1ec1ac";
    const res = await missionAction(new NextRequest(`http://localhost/api/missions/${id}`, { method: "POST", body: JSON.stringify({ action: "cancel" }) }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(db.rows("missions").find((m) => m.id === id)).toMatchObject({ status: "cancelled" });
    // «reload»: a new read of everything
    const all = await index("all");
    expect(all.pending.map((p) => p.id)).not.toContain(id);
    const ended = await index("ended");
    const row = ended.rows.find((r) => r.id === id)!;
    expect(row).toMatchObject({ type: "mission", endedKind: "cancelled" });
    expect(row.type === "mission" && row.noteAr).toContain("ألغيت");
    expect(row.type === "mission" && row.noteAr).not.toContain(EXPIRED_SENTENCE_AR);
    expect(money.calls).toHaveLength(0);
    expect(db.rows("credit_ledger")).toHaveLength(0);
  });

  it("cancelling every waiting mission one by one leaves none of them waiting after a reload", async () => {
    seedLive();
    const waiting = (await index("all")).pending.map((p) => p.id);
    for (const id of waiting) expect(await cancelForCustomer(state.client, { id, userId: ME })).toMatchObject({ ok: true });
    const after = await index("all");
    expect(after.pending).toEqual([]);
    expect(after.counts.ended).toBe(11);
    expect(money.calls).toHaveLength(0);
  });

  it("a cancel whose update matched no row (the mission moved on in the meantime) is told, never answered as a cancel that worked", async () => {
    db.seed("missions", [mission("race", "queued", ago(HOUR))]);
    const racing: any = { from: (t: string) => {
      const b = db.from(t);
      if (t !== "missions") return b;
      return new Proxy(b, { get(target, prop) { const v = target[prop]; return prop === "update" ? (patch: any) => { db.rows("missions")[0].status = "planning"; return v.call(target, patch); } : v; } });
    } };
    const r = await cancelForCustomer(racing, { id: "msn_race", userId: ME });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(db.rows("missions")[0].status).toBe("planning");
  });

  it("another customer's mission is not cancelled, and a mission that already started is refused", async () => {
    db.seed("missions", [mission("theirs", "plan_ready", ago(HOUR), { user_id: "u-2" }), mission("run", "executing", ago(HOUR), { job_id: "job_z" })]);
    expect(await cancelForCustomer(state.client, { id: "msn_theirs", userId: ME })).toMatchObject({ ok: false, status: 404 });
    expect(await cancelForCustomer(state.client, { id: "msn_run", userId: ME })).toMatchObject({ ok: false, status: 409 });
    expect(db.rows("missions").map((m) => m.status)).toEqual(["plan_ready", "executing"]);
  });
});

describe("3. the tabs filter the whole page, and each count is what its tab lists", () => {
  const seedMixed = () => {
    seedLive();
    db.seed("missions", [
      mission("queued1", "queued", ago(2 * HOUR)),
      mission("fail1", "failed", ago(30 * HOUR), { summary_ar: "تعذّر تجهيز خطة لطلبك بسبب حد من جانبنا، ولم يُخصم منك شيء." }),
      mission("uns1", "unserved", ago(31 * HOUR), { summary_ar: "لم نتمكن من تسليم الملف بالدقة المطلوبة." }),
      mission("can1", "cancelled", ago(32 * HOUR)),
      mission("jobm", "completed", ago(40 * HOUR), { job_id: "job_d1", request_text: "هات ٣٠٠ تغريدة عن محمد صلاح" }),
    ]);
    db.seed("jobs", [
      job("job_d1", "completed", ago(40 * HOUR)),
      job("job_d2", "completed", ago(41 * HOUR)),
      job("job_part", "completed", ago(42 * HOUR), { delivered_units: 4 }),
      job("job_run", "running", ago(HOUR)),
      job("job_q", "queued", ago(HOUR + 1000)),
      job("job_f1", "failed", ago(50 * HOUR)),
      job("job_f2", "cancelled", ago(51 * HOUR)),
    ]);
  };

  it("counts: all = running + done + ended + refunded + waiting; every tab lists exactly its count (paged to the end), only its own kind", async () => {
    seedMixed();
    const all = await index("all", { limit: 400 });
    expect(all.counts).toEqual({ all: 22, running: 3, done: 3, ended: 9, refunded: 2 });
    expect(all.counts.all).toBe(all.counts.running + all.counts.done + all.counts.ended + all.counts.refunded + all.pending.length);
    for (const tab of ["running", "done", "ended", "refunded"] as const) {
      const listed: string[] = [];
      for (let offset = 0; ; offset += 2) {
        const page = await index(tab, { offset, limit: 2 });
        listed.push(...page.rows.map((r) => r.id));
        for (const r of page.rows) expect(r.tab, tab).toBe(tab);
        expect(page.pending, tab).toEqual([]);
        if (!page.hasMore) break;
      }
      expect(listed, tab).toHaveLength(all.counts[tab]);
      expect(new Set(listed).size).toBe(listed.length);
    }
    const everything = await index("all", { limit: 400 });
    expect(everything.rows).toHaveLength(everything.counts.all - everything.pending.length);
  });

  it("«قيد التنفيذ» works: queued/planning missions and running or queued jobs; a mission that has a job is that job, never a second row", async () => {
    seedMixed();
    const running = await index("running");
    expect(running.rows.map((r) => r.id).sort()).toEqual(["job_q", "job_run", "msn_queued1"]);
    expect((await index("all", { limit: 400 })).rows.filter((r) => r.id === "msn_jobm")).toHaveLength(0);
  });

  it("a partly delivered job is under «مكتملة»; failed and cancelled jobs are under the released-hold tab", async () => {
    seedMixed();
    expect((await index("done")).rows.map((r) => r.id).sort()).toEqual(["job_d1", "job_d2", "job_part"]);
    expect((await index("refunded")).rows.map((r) => r.id).sort()).toEqual(["job_f1", "job_f2"]);
  });

  it("the questions and plans that wait appear on «الكل» only", async () => {
    seedMixed();
    expect((await index("all")).pending).toHaveLength(5);
    for (const tab of ["running", "done", "ended", "refunded"] as const) expect((await index(tab)).pending).toEqual([]);
  });

  it("the selected tab is kept in the address as an ASCII name: reload reads it back; an unknown name is «الكل»", () => {
    for (const tab of REQUEST_TAB_IDS) { expect(hashOfTab(tab)).toBe(`#${tab}`); expect(hashOfTab(tab)).toMatch(/^#[a-z]+$/); expect(tabFromHash(hashOfTab(tab))).toBe(tab); }
    expect(tabFromHash("")).toBe("all");
    expect(tabFromHash("#bogus")).toBe("all");
    expect(tabFromHash("#مكتملة")).toBe("all");
    expect(tabFromHash("#DONE")).toBe("done");
  });

  it("the page lists the same tabs, in the same order, with the approved words", () => {
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    const ids = [...page.matchAll(/^\s*\["(all|running|done|ended|refunded)", "([^"]+)"\],$/gm)];
    expect(ids.map((m) => m[1])).toEqual([...REQUEST_TAB_IDS]);
    expect(ids.map((m) => m[2])).toEqual(["الكل", "قيد التنفيذ", "مكتملة", "فشلت أو أُلغيت", "حجز مؤقت مُحرَّر"]);
    expect(page).toContain("hashOfTab(next)");
    expect(page).toContain("tabFromHash(window.location.hash)");
  });
});

describe("4. paging, 20 at a time, newest first; and the search, on the server, with the selected tab", () => {
  const seedMany = (n: number) => db.seed("jobs", Array.from({ length: n }, (_, i) => job(`job_${String(i).padStart(3, "0")}`, "completed", new Date(NOW - (i + 1) * 60_000).toISOString())));

  it("45 requests: pages of 20, 20 and 5, newest first, no repeat, hasMore only while more remain", async () => {
    seedMany(45);
    expect(REQUESTS_PAGE_SIZE).toBe(20);
    const p1 = await index("all");
    const p2 = await index("all", { offset: p1.nextOffset });
    const p3 = await index("all", { offset: p2.nextOffset });
    expect([p1.rows.length, p2.rows.length, p3.rows.length]).toEqual([20, 20, 5]);
    expect([p1.hasMore, p2.hasMore, p3.hasMore]).toEqual([true, true, false]);
    const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
    expect(ids).toEqual(Array.from({ length: 45 }, (_, i) => `job_${String(i).padStart(3, "0")}`));
    expect(p1.counts.all).toBe(45);
  });

  it("the route answers the same, 20 by default, and a signed-out caller gets 401", async () => {
    seedMany(30);
    const body = await (await listRequests(new NextRequest("http://localhost/api/requests?tab=done"))).json();
    expect(body).toMatchObject({ success: true, hasMore: true, nextOffset: 20 });
    expect(body.rows).toHaveLength(20);
    expect((await (await listRequests(new NextRequest("http://localhost/api/requests?tab=nonsense"))).json()).rows).toHaveLength(20);
    state.viewer = null;
    expect((await listRequests(new NextRequest("http://localhost/api/requests"))).status).toBe(401);
  });

  const seedSearchable = () => {
    db.seed("missions", [
      mission("m1", "completed", ago(5 * HOUR), { job_id: "job_a", request_text: "هات ٣٠٠ تغريدة عن محمد صلاح" }),
      mission("m2", "completed", ago(6 * HOUR), { job_id: "job_b", request_text: "عايز ١٠ شركات مقاولات في مصر" }),
      mission("m3", "cancelled", ago(7 * HOUR), { request_text: "أحمد: تغريدات عن الأهلي" }),
      mission("m4", "plan_ready", ago(2 * HOUR), { request_text: "تغريدات عن الزمالك" }),
    ]);
    db.seed("jobs", [job("job_a", "completed", ago(5 * HOUR)), job("job_b", "failed", ago(6 * HOUR))]);
  };

  it("searches the request text on the server, with the selected tab; counts follow the search", async () => {
    seedSearchable();
    const all = await index("all", { q: "تغريدة" });
    expect(all.counts).toMatchObject({ all: 1, done: 1, ended: 0, refunded: 0, running: 0 });
    const tweets = await index("all", { q: "تغريدات" });
    expect(tweets.counts.all).toBe(2); // the cancelled one and the waiting plan
    expect(tweets.pending.map((p) => p.id)).toEqual(["msn_m4"]);
    expect((await index("ended", { q: "تغريدات" })).rows.map((r) => r.id)).toEqual(["msn_m3"]);
    expect((await index("done", { q: "تغريدات" })).rows).toEqual([]);
    expect((await index("refunded", { q: "شركات" })).rows.map((r) => r.id)).toEqual(["job_b"]);
    expect((await index("all", { q: "لا يوجد شيء كهذا" })).counts.all).toBe(0);
  });

  it("every word must match, in any order; alef forms, ya/alef-maqsura, ta marbuta, diacritics and Arabic-Indic digits do not hide a match", async () => {
    seedSearchable();
    expect((await index("all", { q: "صلاح محمد" })).rows.map((r) => r.id)).toEqual(["job_a"]);
    expect((await index("all", { q: "احمد" })).rows.map((r) => r.id)).toEqual(["msn_m3"]);
    expect((await index("all", { q: "مقاولات 10" })).rows.map((r) => r.id)).toEqual(["job_b"]);
    expect((await index("all", { q: "عَايز ١٠" })).rows.map((r) => r.id)).toEqual(["job_b"]);
    expect(normalizeSearchText("مدرسة ٥")).toBe("مدرسه 5");
    expect(searchTerms("   ")).toEqual([]);
    expect(matchesSearch("anything", [])).toBe(true);
    expect(searchTerms("x".repeat(500)).join("").length).toBeLessThanOrEqual(80);
  });

  it("an older request (no mission) is found by the title of the conversation it was asked in", async () => {
    db.seed("jobs", [job(getJobIdForQuote("quote-1"), "completed", ago(HOUR)), job("job_other", "completed", ago(2 * HOUR))]);
    db.seed("plans_quotes", [{ id: "quote-1", user_id: ME, status: "accepted", created_at: ago(HOUR) }]);
    db.seed("messages", [{ id: "x", user_id: ME, conversation_id: "conv-1", quote: { quoteId: "quote-1" }, created_at: ago(HOUR) }]);
    db.seed("conversations", [{ id: "conv-1", user_id: ME, title: "مطاعم القاهرة", updated_at: ago(HOUR) }]);
    expect((await index("all", { q: "مطاعم" })).rows.map((r) => r.id)).toEqual([getJobIdForQuote("quote-1")]);
    expect((await index("all")).rows).toHaveLength(2);
  });

  it("only the customer's own requests are listed or counted", async () => {
    db.seed("jobs", [job("job_mine", "completed", ago(HOUR)), job("job_theirs", "completed", ago(HOUR), { user_id: "u-2" })]);
    db.seed("missions", [mission("mine", "cancelled", ago(HOUR)), mission("theirs", "cancelled", ago(HOUR), { user_id: "u-2" })]);
    const all = await index("all");
    expect(all.rows.map((r) => r.id).sort()).toEqual(["job_mine", "msn_mine"]);
    expect(all.counts.all).toBe(2);
  });
});

describe("5. the block and the rows: what the customer reads", () => {
  it("the block shows 5 and «عرض الكل (n)» for the rest; opened, it shows all, newest first", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, createdAt: new Date(NOW - i * 60_000).toISOString() }));
    const closed = pendingBlockView(items, false);
    expect(closed.visible.map((x) => x.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(closed).toMatchObject({ hiddenCount: 2, showAllLabel: "عرض الكل (٧)" });
    expect(pendingBlockView(items, true).visible).toHaveLength(7);
    expect(pendingBlockView(items.slice(0, 5), false).showAllLabel).toBeNull();
    expect(pendingBlockView([], false).visible).toEqual([]);
  });

  it("the block renders its rows with «إلغاء» and the 72-hour sentence, in Arabic only", async () => {
    seedLive();
    const idx = await index("all");
    const html = renderToStaticMarkup(createElement(OpenMissionsList, { items: idx.pending, busyId: null, error: "", onCancel: () => {} }));
    expect((html.match(/data-testid="open-mission"/g) ?? []).length).toBe(5);
    expect((html.match(/>إلغاء</g) ?? []).length).toBe(5);
    expect(html).toContain("مهام قيد الإعداد");
    expect(html).toContain("٧٢ ساعة");
    expect(html).not.toContain("عرض الكل");
    expect(html).not.toMatch(/msn_|USD|treg|provider/i);
  });

  it("the Excel is the customer's one file button; the CSV and the PDF are not offered, except to a request that has no Excel", () => {
    expect(customerFormatsOf(["xlsx", "pdf", "csv"])).toEqual(["xlsx"]);
    expect(customerFormatsOf(["xlsx", "csv"])).toEqual(["xlsx"]);
    expect(customerFormatsOf(["csv"])).toEqual(["csv"]);
    expect(customerFormatsOf(["pdf", "csv"])).toEqual(["pdf"]);
    expect(customerFormatsOf([])).toEqual([]);
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page).toContain("customerFormats.map((ext)");
    expect(page).not.toMatch(/availableFormats\.map\(/);
  });

  it("no customer sentence of an ended request carries a provider, a dollar amount, an internal id or the old row words", async () => {
    seedLive();
    db.seed("missions", [mission("f", "failed", ago(30 * HOUR), { summary_ar: "agent mission failed: treg 403 USD 0.1" }), mission("u", "unserved", ago(31 * HOUR), { summary_ar: "لم نتمكن من تسليم الملف." }), mission("c", "cancelled", ago(32 * HOUR))]);
    const ended = await index("ended", { limit: 400 });
    expect(ended.rows.length).toBeGreaterThanOrEqual(9);
    for (const r of ended.rows) {
      const text = r.type === "mission" ? r.noteAr : "";
      expect(text).not.toMatch(/[A-Za-z]/);
      expect(text).not.toMatch(/صف|سجل|USD|msn_/);
    }
  });

  it("the page reads its list from the server and writes nothing itself", () => {
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page).toContain("/api/requests?");
    expect(page).toContain('data-testid="load-more"');
    expect(page).toContain('data-testid="requests-search"');
    expect(page).toContain("تحميل المزيد");
    expect(page).not.toMatch(/\.(?:update|insert|upsert|delete)\(/);
    // nothing in the page lets a tab scroll sideways
    expect(page).not.toContain("overflow-x-auto");
    expect(page).toContain("flex-wrap");
  });
});
