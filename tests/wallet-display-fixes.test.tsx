import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import SubmittedCard from "../src/app/dashboard/topup/SubmittedCard";
import { classifyLedgerRow, CREDIT_KIND_LABEL_AR } from "../src/lib/creditKinds";
import {
  creditedPointsByTopup, creditedPointsOf, kindOfLedgerRow, ledgerTopupId, visibleLedgerRows, walletMonthStats, type WalletLedgerRow,
} from "../src/lib/walletView";
import { DEFINITIONS_DIR, replicaAvailable, startReplica, type ReplicaDb } from "./helpers/replicaDb";
import { seedUser } from "./helpers/replicaMoney";

/**
 * Wallet display fixes (display only: no money function, ledger row, price or cap changes).
 * 1) the approval screen showed «٠ نقطة» because approve_topup_atomic writes the ledger row as top_<topupId> with an empty topup_id
 *    and the page matched ledger rows to top-ups by topup_id only;
 * 2) «رجع لرصيدك هذا الشهر» summed release - charge per job, which is the lifted hold, not a refund of a charge;
 * 3) the history tab «الكل» had no loading state and was stricter than the typed tabs.
 */

const row = (over: Partial<WalletLedgerRow> & { id: string; type: string; delta: number }): WalletLedgerRow & { $id: string } => ({
  $id: over.id, jobId: null, topupId: null, createdAt: "2026-10-20T10:00:00Z", ...over,
});

const NOW = new Date("2026-10-23T12:00:00Z");

// What approve_topup_atomic writes for a 250 EGP transfer at 0.10 EGP a point: topup_id stays empty, id is top_<topupId>.
const RPC_TOPUP_ROW = row({ id: "top_tp_250", type: "topup", delta: 2500, topupId: null });
const APPROVED_TOPUP = { $id: "tp_250", amountEgp: 250, reference: "R-250", status: "approved" as const, createdAt: "2026-10-23T09:00:00Z", credits: null };

describe("1. top-up approval screen shows the credited points", () => {
  it("a ledger row written by approve_topup_atomic (id top_<id>, no topup_id) is matched to its top-up", () => {
    expect(ledgerTopupId(RPC_TOPUP_ROW)).toBe("tp_250");
    const byTopup = creditedPointsByTopup([RPC_TOPUP_ROW]);
    expect(byTopup.get("tp_250")).toBe(2500);
    expect(creditedPointsOf(APPROVED_TOPUP, byTopup)).toBe(2500);
  });

  it("the older writer (topup_id set) still matches, and only positive top-up rows count", () => {
    const legacy = row({ id: "top_tp_old", type: "topup", delta: 400, topupId: "tp_old" });
    const other = [row({ id: "top_tp_x", type: "grant", delta: 90 }), row({ id: "chg_1", type: "charge", delta: -50, jobId: "j1" }), row({ id: "top_tp_neg", type: "topup", delta: -10 })];
    const byTopup = creditedPointsByTopup([legacy, ...other]);
    expect([...byTopup.entries()]).toEqual([["tp_old", 400]]);
  });

  it("a value stored on the top-up row wins; an unknown value stays unknown, never recomputed from the amount", () => {
    expect(creditedPointsOf({ $id: "tp_250", credits: 2500 }, new Map())).toBe(2500);
    expect(creditedPointsOf({ $id: "tp_250", credits: null }, new Map())).toBeNull();
    expect(creditedPointsOf({ $id: "tp_250", credits: 0 }, new Map())).toBeNull();
  });

  const render = (credits: number | null, status: "approved" | "pending" = "approved") =>
    renderToStaticMarkup(createElement(SubmittedCard, { topup: { ...APPROVED_TOPUP, status, credits }, creditValue: 0.1, onBack: () => {}, onContinue: () => {} }));

  it("the success screen for 250 EGP says 2,500 points in the title and in «النقاط المضافة»", () => {
    const html = render(2500);
    expect(html).toContain("تم اعتماد الطلب وإضافة ٢٬٥٠٠ نقطة");
    expect(html).toMatch(/النقاط المضافة<\/span><span[^>]*>٢٬٥٠٠ نقطة/);
    expect(html).not.toMatch(/(^|[^٠-٩٬])٠ نقطة/);
  });

  it("when the credited points are not known yet the screen never prints ٠ نقطة", () => {
    const html = render(null);
    expect(html).toContain("تم اعتماد الطلب وإضافة النقاط");
    expect(html).not.toMatch(/(^|[^٠-٩٬])٠ نقطة/);
    expect(html).toMatch(/النقاط المضافة<\/span><span[^>]*>—/);
  });

  it("a pending request still shows the expected points from the amount", () => {
    expect(render(null, "pending")).toContain("٢٬٥٠٠ نقطة");
  });

  it("the page feeds the card from the ledger rows and the top-ups list no longer prints ٠ for an approved request", () => {
    const page = readFileSync("src/app/dashboard/topup/page.tsx", "utf8");
    expect(page).toContain("creditedPointsByTopup(ledger)");
    expect(page).toContain("creditedPointsOf(submitted, creditsByTopup)");
    expect(page).not.toContain("t.credits ?? 0");
    expect(readFileSync("src/app/dashboard/topup/SubmittedCard.tsx", "utf8")).not.toContain("topup.credits ?? 0");
  });
});

describe.skipIf(!replicaAvailable())("1b. the real approve_topup_atomic (production body, local PostgreSQL): the row it writes is read back as 2,500", () => {
  let db: ReplicaDb;
  beforeAll(async () => { db = await startReplica(); await db.reset({ functionsDir: DEFINITIONS_DIR }); }, 90_000);
  afterAll(async () => { await db?.stop(); });

  it("250 EGP at 0.10 EGP a point credits 2,500 and the helper finds it from the stored ledger row", async () => {
    const user = await seedUser(db.pool, 0);
    await db.pool.query("insert into public.settings_public(key,value) values ('pricing','{\"creditValueEgp\":0.1}') on conflict (key) do nothing");
    const topupId = `tp_disp_${user}`;
    await db.pool.query("insert into public.topups(id,user_id,amount_egp,reference,sender_name,sender_phone,receipt_file_id) values ($1,$2,250,$3,'a','b','c')", [topupId, user, `ref_${topupId}`]);
    const result = (await db.pool.query("select public.approve_topup_atomic($1,null) as r", [topupId])).rows[0].r;
    expect(result).toMatchObject({ success: true, credits: 2500 });
    const stored = (await db.pool.query("select id, delta, type, topup_id, created_at from public.credit_ledger where user_id = $1 and type = 'topup'", [user])).rows;
    expect(stored).toHaveLength(1);
    const asShown: WalletLedgerRow = { id: stored[0].id, type: stored[0].type, delta: Number(stored[0].delta), topupId: stored[0].topup_id, createdAt: new Date(stored[0].created_at).toISOString() };
    expect(creditedPointsOf({ $id: topupId, credits: null }, creditedPointsByTopup([asShown]))).toBe(2500);
  });
});

describe("2. the month card no longer calls lifted holds a refund", () => {
  // job A finished: reserve 1150 (incl. the 15% buffer), release 1150 (settle releases the whole hold), charge 1000 -> 150 lifted unused
  // job B failed: reserve 500, release 500, no charge -> the whole hold lifted
  // job C running: reserve 300, no release -> held
  // job D released last month: must not count this month
  const fixture: WalletLedgerRow[] = [
    row({ id: "res_a", type: "reserve", delta: -1150, jobId: "job_a", createdAt: "2026-10-05T10:00:00Z" }),
    row({ id: "rel_a", type: "release", delta: 1150, jobId: "job_a", createdAt: "2026-10-05T10:05:00Z" }),
    row({ id: "chg_a", type: "charge", delta: -1000, jobId: "job_a", createdAt: "2026-10-05T10:05:00Z" }),
    row({ id: "res_b", type: "reserve", delta: -500, jobId: "job_b", createdAt: "2026-10-06T10:00:00Z" }),
    row({ id: "rel_b", type: "release", delta: 500, jobId: "job_b", createdAt: "2026-10-06T10:02:00Z" }),
    row({ id: "res_c", type: "reserve", delta: -300, jobId: "job_c", createdAt: "2026-10-22T10:00:00Z" }),
    row({ id: "res_d", type: "reserve", delta: -900, jobId: "job_d", createdAt: "2026-09-20T10:00:00Z" }),
    row({ id: "rel_d", type: "release", delta: 900, jobId: "job_d", createdAt: "2026-09-20T10:03:00Z" }),
    row({ id: "chg_d", type: "charge", delta: -400, jobId: "job_d", createdAt: "2026-09-20T10:03:00Z" }),
    row({ id: "top_tp_1", type: "topup", delta: 5000, createdAt: "2026-10-01T10:00:00Z" }),
  ];

  it("the old query summed (release - charge) per job released this month: 150 unused buffer + 500 failed hold = 650, none of it a refund", () => {
    const stats = walletMonthStats(fixture, NOW);
    expect(stats.releasedHold).toBe(150 + 500);
    expect(stats.releasedJobs).toBe(2);
    expect(stats.charged).toBe(1000);
    expect(stats.held).toBe(300);
    expect(stats).not.toHaveProperty("refunded");
  });

  it("no ledger type is a refund of a charge: charge rows are never added back by anything the card sums", () => {
    // refunding a charge would need a positive row tied to a charge; the allowed types are reserve, release, charge, topup, grant, goodwill
    const stats = walletMonthStats(fixture, NOW);
    const positiveNonTopup = fixture.filter((r) => r.delta > 0 && r.type !== "topup").every((r) => r.type === "release");
    expect(positiveNonTopup).toBe(true);
    expect(stats.releasedHold).toBeLessThan(fixture.filter((r) => r.type === "release").reduce((a, r) => a + r.delta, 0));
  });

  it("the card is worded «محجوز ومُحرَّر» with no refund wording, no plus sign, Arabic only and no emoji", () => {
    const page = readFileSync("src/app/dashboard/topup/page.tsx", "utf8");
    expect(page).toContain("محجوز ومُحرَّر هذا الشهر");
    expect(page).toContain("حجز مؤقت رُفع ولم يُخصم");
    expect(page).not.toContain("رجع لرصيدك");
    expect(page).not.toContain("فرق الحجز");
    expect(page).not.toContain("stats.refunded");
    const card = page.slice(page.indexOf("محجوز ومُحرَّر هذا الشهر") - 200, page.indexOf("خُصم هذا الشهر"));
    expect(card).not.toMatch(/\+\{/);
    expect(card).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(card).not.toMatch(/[A-Za-z]{3,}.*<\/p>/);
  });

  it("the history labels a release row as a lifted hold, not a refund", () => {
    expect(CREDIT_KIND_LABEL_AR.release).toBe("حجز مؤقت مُحرَّر");
    expect(CREDIT_KIND_LABEL_AR.release).not.toContain("استرداد");
    expect(readFileSync("src/app/dashboard/topup/page.tsx", "utf8")).toContain('["refund", "حجز مُحرَّر"]');
  });
});

describe("3. history tab «الكل»", () => {
  const rows: Array<WalletLedgerRow & { $id: string }> = [
    RPC_TOPUP_ROW,
    row({ id: "res_a", type: "reserve", delta: -1150, jobId: "job_a" }),
    row({ id: "rel_a", type: "release", delta: 1150, jobId: "job_a" }),
    row({ id: "chg_a", type: "charge", delta: -1000, jobId: "job_a" }),
    row({ id: "gift_1", type: "grant", delta: 100 }),
    row({ id: "promo_1", type: "topup", kind: "promo_code", delta: 50 }),
  ];

  it("«الكل» lists every row and every typed tab is a subset of it", () => {
    const all = visibleLedgerRows(rows, "all");
    expect(all).toHaveLength(rows.length);
    for (const tab of ["topup", "charge", "refund"] as const) {
      const typed = visibleLedgerRows(rows, tab);
      expect(typed.length).toBeGreaterThan(0);
      for (const r of typed) expect(all).toContain(r);
    }
    const parts = ["topup", "charge", "refund"].flatMap((tab) => visibleLedgerRows(rows, tab as any));
    expect(parts).toHaveLength(all.length);
  });

  it("a row without a type is listed under «الكل» exactly when a typed tab lists it (it was hidden only from «الكل» before)", () => {
    const odd = { ...row({ id: "x1", type: "topup", delta: 10 }), type: undefined } as unknown as WalletLedgerRow;
    expect(kindOfLedgerRow(odd)).toBe("topup");
    expect(visibleLedgerRows([odd], "topup")).toHaveLength(1);
    expect(visibleLedgerRows([odd], "all")).toHaveLength(1);
  });

  it("the empty message appears only after a load finished; before that the page says it is loading", () => {
    const page = readFileSync("src/app/dashboard/topup/page.tsx", "utf8");
    expect(page).toContain("!ledgerFailed && !ledgerLoaded");
    expect(page).toContain("جارٍ تحميل الحركات…");
    expect(page).toContain("!ledgerFailed && ledgerLoaded && visibleLedger.length === 0");
  });

  it("classification is unchanged: release stays its own kind", () => {
    expect(classifyLedgerRow({ type: "release" })).toBe("release");
    expect(kindOfLedgerRow({ type: "release" })).toBe("refund");
  });
});
