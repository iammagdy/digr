import { describe, expect, it } from "vitest";
import { LAUNCH_HARD_CAP, confirmationFor, isEligibleForNews, newsSkipReason, planBatches, runNewsCampaign, type NewsUser } from "../src/lib/launch/newsCampaign";
import { confirmedAt, makeDeps, makeWorld, optedIn } from "./helpers/newsCampaignFakes";

const ctx = { testAccountIds: new Set<string>(), suppressed: new Set<string>() };
const base = optedIn("u1");

describe("isEligibleForNews: truth table", () => {
  it("an opted-in, service-confirmed, ordinary customer is eligible", () => {
    expect(isEligibleForNews(base, ctx)).toBe(true);
  });

  it("guests are never eligible (flag in metadata, or the generated guest address)", () => {
    expect(newsSkipReason({ ...base, user_metadata: { ...base.user_metadata, is_guest: true } }, ctx)).toBe("guest");
    expect(newsSkipReason({ ...base, email: `guest_${"a".repeat(32)}@diger.tech` }, ctx)).toBe("guest");
    expect(newsSkipReason({ ...base, email: `GUEST_${"0f".repeat(16)}@DIGER.TECH` }, ctx)).toBe("guest");
    expect(newsSkipReason({ ...base, email: "guest_abc@diger.tech" }, ctx)).toBeNull(); // not the generated shape: an ordinary address
  });

  it("an address the sign-in service has not confirmed is not eligible", () => {
    expect(newsSkipReason({ ...base, email_confirmed_at: null }, ctx)).toBe("unconfirmed");
    expect(newsSkipReason({ ...base, email_confirmed_at: undefined }, ctx)).toBe("unconfirmed");
  });

  it("a FORGED user_metadata.email_verified never counts (the customer can write it)", () => {
    const forged: NewsUser = { ...base, email_confirmed_at: null, user_metadata: { prefs: { notif: { news: true } }, email_verified: true } };
    expect(newsSkipReason(forged, ctx)).toBe("unconfirmed");
  });

  it("news must be EXACTLY true: undefined, false, \"true\", 1 and no prefs at all are refused", () => {
    for (const news of [undefined, false, "true", 1, null, "on"]) {
      expect(newsSkipReason({ ...base, user_metadata: { prefs: { notif: { news } } } }, ctx), String(news)).toBe("not_opted_in");
    }
    expect(newsSkipReason({ ...base, user_metadata: {} }, ctx)).toBe("not_opted_in");
    expect(newsSkipReason({ ...base, user_metadata: null }, ctx)).toBe("not_opted_in");
    expect(newsSkipReason({ ...base, user_metadata: { prefs: { notif: { topup: true, done: true, refund: true } } } }, ctx)).toBe("not_opted_in");
  });

  it("test accounts (by id, or by the injected classifier) and suppressed addresses are refused", () => {
    expect(newsSkipReason(base, { ...ctx, testAccountIds: new Set(["u1"]) })).toBe("test_account");
    expect(newsSkipReason(base, { ...ctx, isTestAccount: (u) => u.email!.startsWith("u1@") })).toBe("test_account");
    expect(newsSkipReason(base, { ...ctx, suppressed: new Set(["u1@example.test"]) })).toBe("suppressed");
    expect(newsSkipReason({ ...base, email: " U1@Example.Test " }, { ...ctx, suppressed: new Set(["u1@example.test"]) })).toBe("suppressed");
  });

  it("an invalid or missing address is refused", () => {
    for (const email of [null, undefined, "", "no-at-sign", "a@b", "a b@c.d", "<x@y.z>", "a@b.c,d@e.f"]) {
      expect(newsSkipReason({ ...base, email: email as any }, ctx), String(email)).toBe("invalid_address");
    }
  });

  it("the registered-account default is NOT an opt-in: a plain account with nothing set is out", () => {
    expect(isEligibleForNews({ id: "p", email: "p@example.test", email_confirmed_at: confirmedAt, user_metadata: { full_name: "x" } }, ctx)).toBe(false);
  });
});

describe("planBatches", () => {
  it("splits into batches of at most 500 (default)", () => {
    expect(planBatches(0)).toEqual([]);
    expect(planBatches(-3)).toEqual([]);
    expect(planBatches(1)).toEqual([1]);
    expect(planBatches(500)).toEqual([500]);
    expect(planBatches(501)).toEqual([500, 1]);
    expect(planBatches(1200, 500)).toEqual([500, 500, 200]);
    expect(planBatches(7, 3)).toEqual([3, 3, 1]);
    expect(planBatches(10, 0)).toEqual([]);
    expect(planBatches(NaN)).toEqual([]);
  });
});

describe("runNewsCampaign", () => {
  const five = () => ["a", "b", "c", "d", "e"].map((id) => optedIn(id));

  it("the DEFAULT is a dry run: nothing is read for sending, claimed, sent or logged as sent; the genuine counts come back", async () => {
    const w = makeWorld([...five(), optedIn("g", { user_metadata: { is_guest: true, prefs: { notif: { news: true } } } }), optedIn("n", { user_metadata: {} })]);
    const r = await runNewsCampaign(makeDeps(w), { campaign: "launch-2026-11", cap: 100 });
    expect(r.mode).toBe("dry_run");
    expect(r.scanned).toBe(7);
    expect(r.eligible).toBe(5);
    expect(r.wouldSend).toBe(5);
    expect(r.skipped).toEqual({ guest: 1, not_opted_in: 1 });
    expect(r.sent).toBe(0);
    expect(w.sends).toEqual([]);
    expect(w.events.filter((e) => !e.startsWith("list:"))).toEqual([]);
    expect(w.users.every((u) => !(u.app_metadata as any)?.campaigns)).toBe(true);
  });

  it("an explicit dryRun:true with a correct confirm still sends nothing", async () => {
    const w = makeWorld(five());
    await runNewsCampaign(makeDeps(w), { campaign: "launch-2026-11", cap: 5, dryRun: true, confirm: confirmationFor("launch-2026-11", 5) });
    expect(w.sends).toEqual([]);
  });

  it("a dry run's would-send respects the cap", async () => {
    const w = makeWorld(five());
    const r = await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 3 });
    expect(r.eligible).toBe(5);
    expect(r.wouldSend).toBe(3);
  });

  it("a real send with a missing, wrong or other-campaign confirmation is refused before anything happens", async () => {
    for (const confirm of [undefined, "", "send launch-2026-11 5", "SEND launch-2026-11 4", "SEND other 5", "SEND launch-2026-11 5 ", "yes"]) {
      const w = makeWorld(five());
      const r = await runNewsCampaign(makeDeps(w), { campaign: "launch-2026-11", cap: 5, dryRun: false, confirm });
      expect(r.mode, String(confirm)).toBe("refused");
      expect(r.refused).toBe("confirm_mismatch");
      expect(w.events).toEqual([]);
      expect(w.sends).toEqual([]);
    }
  });

  it("a real send needs dryRun === false: undefined, null, 0 and \"false\" are all dry runs and send nothing", async () => {
    for (const dryRun of [undefined, null, "false", 0] as any[]) {
      const w = makeWorld(five());
      const r = await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 5, dryRun, confirm: confirmationFor("c1", 5) });
      expect(r.mode, String(dryRun)).toBe("dry_run");
      expect(w.sends, String(dryRun)).toEqual([]);
    }
  });

  it("refuses a bad campaign name, a bad cap, and a real send with nothing to announce", async () => {
    const w = makeWorld(five());
    expect((await runNewsCampaign(makeDeps(w), { campaign: "bad name!", cap: 5 })).refused).toBe("invalid_campaign");
    for (const cap of [0, -1, 1.5, NaN, "5" as any]) expect((await runNewsCampaign(makeDeps(w), { campaign: "c1", cap })).refused, String(cap)).toBe("invalid_cap");
    const r = await runNewsCampaign(makeDeps(w, { compose: () => null }), { campaign: "c1", cap: 5, dryRun: false, confirm: confirmationFor("c1", 5) });
    expect(r.refused).toBe("nothing_to_announce");
    expect(w.sends).toEqual([]);
    const dry = await runNewsCampaign(makeDeps(w, { compose: () => null }), { campaign: "c1", cap: 5 });
    expect(dry.mode).toBe("dry_run");
    expect(dry.hasContent).toBe(false);
    expect(dry.eligible).toBe(5);
  });

  it("a confirmed real send mails every eligible user once, with the idempotency key and the unsubscribe URL", async () => {
    const w = makeWorld(five());
    const r = await runNewsCampaign(makeDeps(w), { campaign: "launch-2026-11", cap: 10, dryRun: false, confirm: confirmationFor("launch-2026-11", 10) });
    expect(r.mode).toBe("send");
    expect(r.sent).toBe(5);
    expect(r.sentUserIds).toEqual(["a", "b", "c", "d", "e"]);
    expect(w.sends.map((s) => s.idempotencyKey)).toEqual(["a", "b", "c", "d", "e"].map((id) => `launch-2026-11:${id}`));
    expect(w.sends[0].unsubscribeUrl).toBe("https://diger.test/api/email/unsubscribe?t=tok-a");
    expect(w.sends[0].to).toBe("a@example.test");
    expect(w.sends[0].vars.Name).toBe("مستخدم a");
    expect(r.stopped).toBe("end_of_list");
    // the mark is service-owned app_metadata, not user_metadata
    expect((w.users[0].app_metadata as any).campaigns["launch-2026-11"]).toBe("2026-11-10T09:00:00.000Z");
    expect(w.users[0].user_metadata).toEqual(optedIn("a").user_metadata);
  });

  it("the cap is respected, and never above the hard cap of 500", async () => {
    const w = makeWorld(five());
    const r = await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 3, dryRun: false, confirm: confirmationFor("c1", 3) });
    expect(r.sent).toBe(3);
    expect(r.stopped).toBe("cap_reached");
    expect(w.sends).toHaveLength(3);

    expect(LAUNCH_HARD_CAP).toBe(500);
    const many = makeWorld(Array.from({ length: 520 }, (_, i) => optedIn(`m${i}`)));
    const big = await runNewsCampaign(makeDeps(many, {}, 200), { campaign: "c1", cap: 100000, dryRun: false, confirm: confirmationFor("c1", 100000) });
    expect(big.cap).toBe(500);
    expect(big.sent).toBe(500);
    expect(many.sends).toHaveLength(500);
    const dry = await runNewsCampaign(makeDeps(many, {}, 200), { campaign: "c1", cap: 100000 });
    expect(dry.wouldSend).toBe(20); // 520 eligible, 500 already marked
  });

  it("RE-CHECKS before each send: a preference flipped to false (or an address unconfirmed) after the listing is skipped", async () => {
    const w = makeWorld(five());
    w.beforeReread = (id) => {
      if (id === "b") w.users.find((u) => u.id === "b")!.user_metadata = { prefs: { notif: { news: false } } };
      if (id === "c") w.users.find((u) => u.id === "c")!.email_confirmed_at = null;
    };
    const r = await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(r.sentUserIds).toEqual(["a", "d", "e"]);
    expect(r.skipped).toEqual({ not_opted_in: 1, unconfirmed: 1 });
    expect(w.sends.map((s) => s.userId)).not.toContain("b");
    expect(w.events).not.toContain("claim:b");
  });

  it("a user deleted between the listing and the send is skipped (unreadable)", async () => {
    const w = makeWorld(five());
    w.beforeReread = (id) => { if (id === "a") w.users = w.users.filter((u) => u.id !== "a"); };
    const r = await runNewsCampaign(makeDeps(w, {}, 10), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(r.skipped.unreadable).toBe(1);
    expect(w.sends.map((s) => s.userId)).not.toContain("a");
  });

  it("a user who already carries the mark is skipped (a re-run sends nothing twice), also when marked after the listing", async () => {
    const w = makeWorld([optedIn("a", { app_metadata: { campaigns: { c1: "2026-11-09T00:00:00Z" } } }), optedIn("b"), optedIn("c")]);
    w.beforeReread = (id) => { if (id === "c") w.users.find((u) => u.id === "c")!.app_metadata = { campaigns: { c1: "x" } }; };
    const r = await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(r.sentUserIds).toEqual(["b"]);
    expect(r.skipped.already_sent).toBe(2);
    const again = await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(again.sent).toBe(0);
    expect(w.sends).toHaveLength(1);
  });

  it("a mark of ANOTHER campaign does not block this one", async () => {
    const w = makeWorld([optedIn("a", { app_metadata: { campaigns: { other: "x" } } })]);
    const r = await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(r.sent).toBe(1);
  });

  it("CLAIMS the mark BEFORE sending, for every recipient", async () => {
    const w = makeWorld(five().slice(0, 3));
    await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    for (const id of ["a", "b", "c"]) {
      const order = w.events.filter((e) => e.endsWith(`:${id}`) && !e.startsWith("list"));
      expect(order, id).toEqual([`reread:${id}`, `claim:${id}`, `send:${id}`]);
    }
  });

  it("a send that never gets a claim is not sent, and two claim failures in a row stop the run", async () => {
    const w = makeWorld(five());
    const r = await runNewsCampaign(makeDeps(w, { markSent: async () => false }), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(w.sends).toEqual([]);
    expect(r.stopped).toBe("consecutive_failures");
    expect(r.skipped.claim_failed).toBe(2);
  });

  it("a DEFINITE failure removes the claim; an ambiguous one (timeout, network) keeps it so it cannot be sent twice", async () => {
    const w = makeWorld(five().slice(0, 3), [{ ok: false, reason: "resend_rejected" }, { ok: true }, { ok: false, reason: "timeout" }]);
    const r = await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(r.failedUserIds).toEqual(["a", "c"]);
    expect(r.sentUserIds).toEqual(["b"]);
    expect(w.events).toContain("unclaim:a");
    expect(w.events).not.toContain("unclaim:c");
    expect((w.users[0].app_metadata as any).campaigns).toEqual({});
    expect((w.users[2].app_metadata as any).campaigns.c1).toBeTruthy();
  });

  it("stops the whole run after 2 consecutive failures; a success in between resets the count", async () => {
    const w = makeWorld(five(), [{ ok: false, reason: "resend_rejected" }, { ok: false, reason: "resend_rejected" }]);
    const r = await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(r.stopped).toBe("consecutive_failures");
    expect(w.sends).toHaveLength(2);

    const w2 = makeWorld(five(), [{ ok: false, reason: "resend_rejected" }, { ok: true }, { ok: false, reason: "resend_rejected" }, { ok: true }]);
    const r2 = await runNewsCampaign(makeDeps(w2), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(r2.stopped).toBe("end_of_list");
    expect(w2.sends).toHaveLength(5);
  });

  it("stops at the FIRST unauthorized or resend_not_configured", async () => {
    for (const reason of ["unauthorized", "resend_not_configured"]) {
      const w = makeWorld(five(), [{ ok: false, reason }]);
      const r = await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
      expect(r.stopped).toBe(reason);
      expect(w.sends).toHaveLength(1);
      expect(w.events).toContain("unclaim:a");
    }
  });

  it("a sender that throws counts as an ambiguous failure, not a crash", async () => {
    const w = makeWorld(five());
    const r = await runNewsCampaign(makeDeps(w, { send: async () => { throw new Error("kaboom a@example.test"); } }), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(r.stopped).toBe("consecutive_failures");
    expect(JSON.stringify(r) + JSON.stringify(w.logs)).not.toContain("kaboom");
  });

  it("a failed listing stops the run cleanly", async () => {
    const w = makeWorld(five());
    const r = await runNewsCampaign(makeDeps(w, { listUsers: async () => { throw new Error("db down"); } }), { campaign: "c1", cap: 10 });
    expect(r.stopped).toBe("list_failed");
  });

  it("results and logs hold NO address and NO body, only counts, ids, keys and fixed codes", async () => {
    const w = makeWorld(five(), [{ ok: true }, { ok: false, reason: "resend_rejected" }]);
    const r = await runNewsCampaign(makeDeps(w), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    const dry = await runNewsCampaign(makeDeps(makeWorld(five())), { campaign: "c1", cap: 10 });
    for (const blob of [JSON.stringify(r), JSON.stringify(dry), JSON.stringify(w.logs)]) {
      expect(blob).not.toContain("@");
      expect(blob).not.toContain("example.test");
      expect(blob).not.toContain("جدول");
      expect(blob).not.toContain("مستخدم");
    }
    expect(w.logs.some((l) => l.event === "sent" && l.fields.key === "c1:a")).toBe(true);
  });

  it("de-duplicates a user listed twice (paging while the list moves)", async () => {
    const w = makeWorld([optedIn("a"), optedIn("b")]);
    const deps = makeDeps(w, { listUsers: async (page) => (page <= 2 ? structuredClone(w.users) : []) });
    const r = await runNewsCampaign(deps, { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(r.sent).toBe(2);
    expect(w.sends).toHaveLength(2);
  });

  it("test accounts and suppressed addresses are skipped in a real run too", async () => {
    const w = makeWorld(five());
    const r = await runNewsCampaign(makeDeps(w, { testAccountIds: new Set(["a"]), suppressed: new Set(["b@example.test"]) }), { campaign: "c1", cap: 10, dryRun: false, confirm: confirmationFor("c1", 10) });
    expect(r.sentUserIds).toEqual(["c", "d", "e"]);
    expect(r.skipped).toEqual({ test_account: 1, suppressed: 1 });
  });
});
