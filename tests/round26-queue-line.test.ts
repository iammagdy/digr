import { describe, expect, it } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { listOpenMissions, openMissionView } from "../src/lib/agentMission/openMissions";

/**
 * ROUND 26, item 4: «طلبك في الدور» was shown for a queued mission while the customer had no other running request.
 * The label of a queued mission now says what is true: «استلمنا طلبك، وسيبدأ تلقائيًا» when the customer has nothing running; «سيبدأ طلبك تلقائيًا بعد انتهاء طلبك الجاري»
 * only when the customer really has a planning or executing request with a live lease. Another customer's mission never changes the label.
 */
const ME = "u-1";
const OTHER = "u-2";
const NOW = Date.parse("2026-11-04T12:20:30Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const m = (id: string, user: string, status: string, over: Record<string, unknown> = {}) => ({ id: `msn_${id}`, user_id: user, status, request_text: `طلب ${id}`, created_at: ago(20_000), lease_until: null, job_id: null, ...over });
let db: MemoryDb;
const clientOf = (d: MemoryDb) => { const money = fakeMoneyClient(); return { client: { from: (t: string) => d.from(t), rpc: money.client.rpc } as any }; };

describe("ROUND 26 item 4: the queued label tells the truth", () => {
  it("a queued mission with nothing else running says it is received and will start now, never «في الدور»", () => {
    const v = openMissionView({ id: "msn_q", status: "queued", request_text: "x", created_at: ago(20_000), lease_until: null }, NOW, { ownRunning: 0 });
    expect(v?.stateAr).toBe("استلمنا طلبك، وسيبدأ تلقائيًا");
    expect(v?.stateAr).not.toContain("في الدور");
  });

  it("a queued mission while the customer's own request runs says it starts after that one", () => {
    const v = openMissionView({ id: "msn_q", status: "queued", request_text: "x", created_at: ago(20_000), lease_until: null }, NOW, { ownRunning: 1 });
    expect(v?.stateAr).toBe("سيبدأ طلبك تلقائيًا بعد انتهاء طلبك الجاري");
  });

  it("the default (no count given) is never the own-running sentence", () => {
    const v = openMissionView({ id: "msn_q", status: "queued", request_text: "x", created_at: ago(20_000), lease_until: null }, NOW);
    expect(v?.stateAr).not.toContain("الجاري");
  });

  it("from the database: another customer's running mission does not change the label; the customer's own live one does", async () => {
    db = createMemoryDb();
    db.seed("missions", [
      m("q", ME, "queued"),
      m("other", OTHER, "executing", { lease_until: ago(-MIN) }),
    ]);
    const { client } = clientOf(db);
    let list = await listOpenMissions(client, { userId: ME, now: NOW });
    expect(list.find((v) => v.id === "msn_q")?.stateAr).toBe("استلمنا طلبك، وسيبدأ تلقائيًا");

    db.seed("missions", [m("own", ME, "planning", { lease_until: ago(-MIN) })]);
    list = await listOpenMissions(client, { userId: ME, now: NOW });
    expect(list.find((v) => v.id === "msn_q")?.stateAr).toBe("سيبدأ طلبك تلقائيًا بعد انتهاء طلبك الجاري");
  });

  it("a customer's own planning mission whose lease ran out is not a running request", async () => {
    db = createMemoryDb();
    db.seed("missions", [m("q", ME, "queued"), m("old", ME, "planning", { lease_until: ago(10 * MIN) })]);
    const list = await listOpenMissions(clientOf(db).client, { userId: ME, now: NOW });
    expect(list.find((v) => v.id === "msn_q")?.stateAr).toBe("استلمنا طلبك، وسيبدأ تلقائيًا");
  });
});
