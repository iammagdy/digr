import { describe, expect, it } from "vitest";
import { queueLine } from "../src/lib/agentMission/customerView";
import { readQueue } from "../src/lib/agentMission/customerActions";
import { AGENT_QUEUE_LINE_AR } from "../src/lib/agentMission/constants";
import { PLANNING_USUAL_TIME_AR } from "../src/lib/missionView";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * ROUND 14, item 7: THE QUEUE NOTICE. Live (msn_5d5a9b2a933aeaa47d81, from SELECTs): the YouTube request was created 15:44:11 and its planning started 15:48:45, when the customer's OWN Facebook request (15:39 to 15:48:40) ended. The card had said «مهمتك في الدور وهتبدأ خلال دقائق · ترتيب ١» and
 * «عادةً دقيقة أو اتنين، ولن يُخصم شيء قبل موافقتك»: a time nothing measured, a position that was no wait for other customers, two dialects.
 */
const NOW = Date.parse("2026-11-03T15:46:00Z");
const noTime = (t: string) => { expect(t).not.toMatch(/دقيقة|دقائق|ساعة|خلال|عادةً|ثانية/); expect(t).not.toMatch(/[0-9]/); expect(t).not.toMatch(/هتبدأ|ترتيب/); };

describe("queueLine says why it waits, and never a time", () => {
  it("behind the customer's own running request: «سيبدأ تلقائيًا بعد انتهائه» (the live case)", () => {
    const q = queueLine("queued", { ahead: 0, running: 1, workerAlive: true, aheadOwn: 0, runningOwn: 1 });
    expect(q.lineAr).toBe("طلبك ينتظر لأن لديك طلبًا جاريًا؛ سيبدأ تلقائيًا بعد انتهائه.");
    noTime(q.lineAr!);
  });
  it("behind other customers: the real count, no time, no «ترتيب»", () => {
    const q = queueLine("queued", { ahead: 2, running: 1, workerAlive: true, aheadOwn: 0, runningOwn: 0 });
    expect(q.lineAr).toBe("طلبك ينتظر دوره؛ قبله ٣ من الطلبات الجارية أو المنتظرة، وسيبدأ تلقائيًا عند دوره.");
    expect(q.position).toBe(3);
    noTime(q.lineAr!);
  });
  it("both: the own running request and other customers'", () => {
    const q = queueLine("queued", { ahead: 1, running: 2, workerAlive: true, aheadOwn: 0, runningOwn: 1 });
    expect(q.lineAr).toBe("طلبك ينتظر لأن لديك طلبًا جاريًا، وقبله ٢ من طلبات العملاء الآخرين؛ سيبدأ تلقائيًا بعد انتهاء ما قبله.");
    noTime(q.lineAr!);
  });
  it("a queue with no own information counts everything as other customers' (as the old view did)", () => {
    expect(queueLine("queued", { ahead: 2, running: 1, workerAlive: true }).lineAr).toContain("قبله ٣");
  });
  it("nothing ahead and nothing running: no line; the worker away: formal Arabic, no time", () => {
    expect(queueLine("queued", { ahead: 0, running: 0, workerAlive: true }).lineAr).toBeNull();
    const away = queueLine("queued", { ahead: 0, running: 0, workerAlive: false }).lineAr!;
    expect(away).toBe("الخدمة متوقفة مؤقتًا. مهمتك محفوظة وستبدأ تلقائيًا عند عودة الخدمة للعمل.");
    noTime(away);
  });
  it("the second line keeps the money promise and states no time; every sentence passes checkCustomerText", () => {
    expect(PLANNING_USUAL_TIME_AR).toBe("ولن يُخصم شيء قبل موافقتك.");
    expect(PLANNING_USUAL_TIME_AR).toContain("ولن يُخصم شيء قبل موافقتك");
    noTime(PLANNING_USUAL_TIME_AR);
    noTime(AGENT_QUEUE_LINE_AR);
    for (const t of [PLANNING_USUAL_TIME_AR, AGENT_QUEUE_LINE_AR, queueLine("queued", { ahead: 0, running: 1, workerAlive: true, runningOwn: 1, aheadOwn: 0 }).lineAr!]) expect(checkCustomerText(t, { maxChars: 400 }).issues, t).toEqual([]);
  });
});

/** A tiny fake of the table: `select(count, head)` with the filters the queue uses. */
function fakeClient(missions: Array<{ id: string; user_id: string; status: string; created_at: string; lease_until: string | null }>) {
  const from = (table: string) => {
    const filters: Array<(m: (typeof missions)[number]) => boolean> = [];
    const builder: any = {
      select: () => builder,
      in: (col: string, vals: string[]) => { filters.push((m) => vals.includes((m as any)[col])); return builder; },
      lt: (col: string, v: string) => { filters.push((m) => String((m as any)[col]) < v); return builder; },
      gt: (col: string, v: string) => { filters.push((m) => (m as any)[col] !== null && String((m as any)[col]) > v); return builder; },
      neq: (col: string, v: string) => { filters.push((m) => (m as any)[col] !== v); return builder; },
      eq: (col: string, v: string) => { filters.push((m) => (m as any)[col] === v); return builder; },
      order: () => builder, limit: () => builder,
      then: (resolve: (r: unknown) => void) => resolve(table === "agent_heartbeat" || table.includes("heartbeat") ? { data: [{ beat_at: new Date(NOW - 5000).toISOString() }] } : { count: missions.filter((m) => filters.every((f) => f(m))).length }),
    };
    return builder;
  };
  return { from };
}

describe("readQueue counts the customer's own requests apart", () => {
  const lease = new Date(NOW + 3_600_000).toISOString();
  const mine = "user_me";
  it("the live case: my Facebook request is executing, my YouTube request waits: aheadOwn 0, runningOwn 1, running 1", async () => {
    const client = fakeClient([
      { id: "msn_fb", user_id: mine, status: "executing", created_at: "2026-11-03T15:39:39Z", lease_until: lease },
      { id: "msn_yt", user_id: mine, status: "queued", created_at: "2026-11-03T15:44:11Z", lease_until: null },
    ]);
    const q = await readQueue(client, { id: "msn_yt", created_at: "2026-11-03T15:44:11Z", status: "queued", user_id: mine }, NOW);
    expect(q).toMatchObject({ ahead: 0, running: 1, aheadOwn: 0, runningOwn: 1 });
    expect(queueLine("queued", q).lineAr).toBe("طلبك ينتظر لأن لديك طلبًا جاريًا؛ سيبدأ تلقائيًا بعد انتهائه.");
  });
  it("another customer's running request is not mine", async () => {
    const client = fakeClient([
      { id: "msn_other", user_id: "user_other", status: "executing", created_at: "2026-11-03T15:39:39Z", lease_until: lease },
      { id: "msn_yt", user_id: mine, status: "queued", created_at: "2026-11-03T15:44:11Z", lease_until: null },
    ]);
    const q = await readQueue(client, { id: "msn_yt", created_at: "2026-11-03T15:44:11Z", status: "queued", user_id: mine }, NOW);
    expect(q).toMatchObject({ running: 1, runningOwn: 0 });
    expect(queueLine("queued", q).lineAr).toContain("قبله ١");
  });
});
