import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replicaAvailable, startReplica, type ReplicaDb } from "./helpers/replicaDb";

describe.skipIf(!replicaAvailable())("replica smoke", () => {
  let db: ReplicaDb;
  beforeAll(async () => { db = await startReplica(); await db.reset(); }, 60_000);
  afterAll(async () => { await db?.stop(); });
  it("loads the real functions and triggers", async () => {
    const { rows } = await db.pool.query("select count(*)::int as n from pg_proc where pronamespace='public'::regnamespace");
    expect(rows[0].n).toBeGreaterThan(15);
    const t = await db.pool.query("select count(*)::int as n from pg_trigger where not tgisinternal");
    expect(t.rows[0].n).toBe(3);
  });
});
