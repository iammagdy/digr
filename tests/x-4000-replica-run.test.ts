import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chargeForUnits, reserveForUnits } from "../src/lib/recordPricing";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb } from "./helpers/chatSession";
import { replicaAvailable, startReplica, type ReplicaDb } from "./helpers/replicaDb";
import { acceptQuote, balanceOf, createQuote, deliver, ledgerOf, seedUser, settle } from "./helpers/replicaMoney";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
  getEndpointDetails: vi.fn(async (id: string) => ({ id, catalogPriceUsd: 0.005, pointsPerUnit: 28 })),
}));
import { ChatHandler } from "../src/functions/shared/chatHandler";

const PROPOSAL = path.resolve(__dirname, "..", "docs", "proposals", "job-cap-5000", "functions");
const REPORT = process.env.X4000_REPORT_PATH;

/**
 * One X job of about 4,000 posts through the REAL quote writer (the chat handler, model stubbed to throw) and the PROPOSED money functions (cap 5,000)
 * in a local PostgreSQL replica: quote, reserve, delivery in chunks of 100 rows, charge, ledger rows. No provider, no model, no Supabase, no production.
 */
describe.skipIf(!replicaAvailable() || !REPORT)("an X job of about 4,000 posts: real quote writer, proposed money functions", () => {
  let db: ReplicaDb;
  beforeAll(async () => { db = await startReplica(); await db.reset({ functionsDir: PROPOSAL, beforeFunctions: [] }); }, 90_000);
  afterAll(async () => { await db?.stop(); });

  it("quotes, reserves, delivers and charges exactly", async () => {
    setProviderBalanceForTesting(10);
    const chat = createChatDb();
    const handler = new ChatHandler(chat as any);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
    const res: any = await handler.handleUserMessage({ userId: "u_x4000", message: "هات ٤٠٠٠ تغريدة عن الغلاء على إكس آخر شهر", userBalance: 5000 });
    resetProviderBalanceCacheForTesting();
    const quote = res.planQuote;
    expect(quote.targetVolumeMax).toBe(4000);
    expect(quote.unitPricePoints).toBe(0.11715);
    expect(quote.expectedPoints).toBe(chargeForUnits(4000, 0.11715));
    expect(quote.quotedPoints).toBe(reserveForUnits(4000, 0.11715));

    const user = await seedUser(db.pool, 5000);
    const before = await balanceOf(db.pool, user);
    const created = await createQuote(db.pool, user, { unit: 0.11715, volume: 4000, reserve: quote.quotedPoints });
    const accepted = await acceptQuote(db.pool, user, created.quoteId);
    expect(accepted.success).toBe(true);
    const afterReserve = await balanceOf(db.pool, user);
    const jobId = accepted.job_id as string;
    await deliver(db.pool, jobId, 4000, 100, true);
    const settled = await settle(db.pool, jobId, 5000);
    const afterSettle = await balanceOf(db.pool, user);
    const ledger = await ledgerOf(db.pool, jobId);
    const job = (await db.pool.query("select status, delivered_units, reserved_credits::float8 reserved, charged_credits::float8 charged, unit_price::float8 unit_price, step from public.jobs where id=$1", [jobId])).rows[0];
    // partial run (delivered 3,000 of 4,000) and a zero-delivery run on the same quote size, for the report
    const second = await createQuote(db.pool, user, { unit: 0.11715, volume: 4000, reserve: quote.quotedPoints });
    const acc2 = await acceptQuote(db.pool, user, second.quoteId);
    await deliver(db.pool, acc2.job_id, 3000, 100, false);
    const settled2 = await settle(db.pool, acc2.job_id, 5000);
    const ledger2 = await ledgerOf(db.pool, acc2.job_id);
    const duration = quote.duration ?? null;
    writeFileSync(REPORT!, JSON.stringify({
      quote: { unit: quote.unitPricePoints, volume: quote.targetVolumeMax, charge: quote.expectedPoints, reserve: quote.quotedPoints, cap: quote.pointsCap, capConstrained: quote.pointsCapConstrained, summaryAr: quote.summaryAr },
      duration,
      balance: { before, afterReserve, afterSettle },
      job, settled, ledger: ledger.rows.map((r: any) => ({ type: r.type, delta: r.delta })), counts: ledger.counts,
      partial3000: { settled: settled2, charge: ledger2.charge, release: ledger2.release, net: ledger2.net, expectedCharge: chargeForUnits(3000, 0.11715) },
    }, null, 2));
    expect(job.charged).toBe(chargeForUnits(4000, 0.11715));
    expect(ledger.net).toBe(-job.charged);
    expect(ledger.counts).toEqual({ reserve: 1, release: 1, charge: 1 });
    expect(afterSettle).toBe(before - job.charged);
    expect(ledger2.charge).toBe(-chargeForUnits(3000, 0.11715));
  }, 60_000);
});
