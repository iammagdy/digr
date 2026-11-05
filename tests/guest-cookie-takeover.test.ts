import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { cleanMutants, loadMutant } from "./helpers/mutants";
import { GUEST_EMAIL_RE, guestUuidOfCookie, isDisposableGuestAccount, ownGuestAccountId } from "../src/lib/server/guestIdentity";

/**
 * SECURITY (release review, 5 Nov 2026): `guest_session_id` is a cookie the BROWSER chooses. Before this fix `/api/chat`
 *  - (signed in) moved the conversations, messages AND missions of the user id named by `gst_<uuid>` to the caller and tried to delete that account,
 *  - (not signed in) acted as that user id,
 * whether or not the id belonged to a real customer. Anyone who learned another customer's user id (a UUID: not guessable, but not a secret either) could take that customer's missions (and so their paid files).
 * Fake sign-in service and in-memory tables only. No network, no money.
 */
const state = vi.hoisted(() => ({ user: null as any, db: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })), updateUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.db),
}));
import { POST as realPost } from "../src/app/api/chat/route";
afterAll(cleanMutants);

const VICTIM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";   // a REAL, confirmed customer
const GUEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";    // a disposable guest Diger made
const ATTACKER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // a signed-in, confirmed customer
const FAKE_GUEST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // a real customer who SELF-SET user_metadata.is_guest
const guestEmail = `guest_${"0123456789abcdef".repeat(2)}@diger.tech`;
const USERS: Record<string, any> = {
  [VICTIM]: { id: VICTIM, email: "victim@example.com", email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} },
  [GUEST]: { id: GUEST, email: guestEmail, email_confirmed_at: null, user_metadata: { is_guest: true } },
  [ATTACKER]: { id: ATTACKER, email: "attacker@example.com", email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} },
  [FAKE_GUEST]: { id: FAKE_GUEST, email: "someone@example.com", email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: { is_guest: true } },
};

let db: MemoryDb;
let deleted: string[];
let created: number;
function world(opts: { createFails?: boolean } = {}) {
  db = createMemoryDb();
  deleted = []; created = 0;
  (db.auth.admin as any).getUserById = async (id: string) => ({ data: { user: USERS[id] ?? null }, error: null });
  (db.auth.admin as any).deleteUser = async (id: string) => { deleted.push(id); return { error: null }; };
  (db.auth.admin as any).createUser = async () => { created += 1; return opts.createFails ? { data: { user: null }, error: { message: "boom" } } : { data: { user: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } }, error: null }; };
  for (const id of Object.keys(USERS)) db.seed("profiles", [{ id, email: USERS[id].email }]);
  db.seed("conversations", [{ id: "cv_victim", user_id: VICTIM }, { id: "cv_guest", user_id: GUEST }]);
  db.seed("messages", [{ id: "m_victim", user_id: VICTIM }, { id: "m_guest", user_id: GUEST }]);
  db.seed("missions", [{ id: "msn_victim", user_id: VICTIM, created_by: VICTIM }, { id: "msn_guest", user_id: GUEST, created_by: GUEST }]);
  state.db = db;
}
const send = (post: typeof realPost, cookie: string | null, extra: Record<string, unknown> = {}) =>
  post(new NextRequest("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ message: "مرحبا", ...extra }), headers: { "content-type": "application/json", ...(cookie ? { cookie: `guest_session_id=${cookie}` } : {}) } }));
const owner = (table: string, id: string) => (db.rows(table).find((r: any) => r.id === id) as any)?.user_id;

describe("the identity helpers", () => {
  it("only a Diger-made, unconfirmed guest account is disposable (the metadata mark alone proves nothing)", () => {
    expect(isDisposableGuestAccount(USERS[GUEST])).toBe(true);
    expect(isDisposableGuestAccount(USERS[VICTIM])).toBe(false);
    expect(isDisposableGuestAccount(USERS[FAKE_GUEST]), "self-set mark on a confirmed customer").toBe(false);
    expect(isDisposableGuestAccount({ ...USERS[GUEST], email_confirmed_at: "2026-11-01T00:00:00Z" })).toBe(false);
    expect(isDisposableGuestAccount({ ...USERS[GUEST], email: "someone@example.com" }), "metadata mark but an ordinary address").toBe(false);
    expect(isDisposableGuestAccount({ ...USERS[GUEST], user_metadata: {} })).toBe(false);
    expect(isDisposableGuestAccount({ ...USERS[GUEST], user_metadata: { is_guest: "true" } })).toBe(false);
    expect(isDisposableGuestAccount(null)).toBe(false);
    expect(GUEST_EMAIL_RE.test("guest_abc@diger.tech")).toBe(false);
    expect(GUEST_EMAIL_RE.test(`guest_${"a".repeat(32)}@diger.tech.evil.com`)).toBe(false);
  });
  it("the cookie form", () => {
    expect(guestUuidOfCookie(`gst_${GUEST}`)).toBe(GUEST);
    expect(guestUuidOfCookie(GUEST)).toBeNull();
    expect(guestUuidOfCookie("gst_not-a-uuid")).toBeNull();
    expect(guestUuidOfCookie(null)).toBeNull();
  });
  it("ownGuestAccountId: guest yes; real customer, unknown id, wrong id, lookup error: no", async () => {
    world();
    expect(await ownGuestAccountId(db, `gst_${GUEST}`)).toBe(GUEST);
    expect(await ownGuestAccountId(db, `gst_${VICTIM}`)).toBeNull();
    expect(await ownGuestAccountId(db, `gst_${FAKE_GUEST}`)).toBeNull();
    expect(await ownGuestAccountId(db, "gst_00000000-0000-4000-8000-000000000000")).toBeNull();
    (db.auth.admin as any).getUserById = async () => { throw new Error("down"); };
    expect(await ownGuestAccountId(db, `gst_${GUEST}`), "a failed lookup proves nothing").toBeNull();
    (db.auth.admin as any).getUserById = async () => ({ data: { user: { ...USERS[GUEST], id: VICTIM } } });
    expect(await ownGuestAccountId(db, `gst_${GUEST}`), "the service answered for another id").toBeNull();
  });
});

describe("POST /api/chat with a guest_session_id cookie the browser chose", () => {
  beforeEach(() => { world(); });

  it("SIGNED IN + cookie naming ANOTHER CUSTOMER: nothing of theirs moves and their account is not deleted", async () => {
    state.user = USERS[ATTACKER];
    await send(realPost, `gst_${VICTIM}`);
    expect(owner("conversations", "cv_victim")).toBe(VICTIM);
    expect(owner("messages", "m_victim")).toBe(VICTIM);
    expect(owner("missions", "msn_victim")).toBe(VICTIM);
    expect((db.rows("missions").find((r: any) => r.id === "msn_victim") as any).created_by).toBe(VICTIM);
    expect(deleted).toEqual([]);
  });

  it("SIGNED IN + cookie naming a customer who set is_guest on their own account: still not adopted", async () => {
    state.user = USERS[ATTACKER];
    await send(realPost, `gst_${FAKE_GUEST}`);
    expect(deleted).toEqual([]);
  });

  it("SIGNED IN + the caller's OWN guest cookie: the guest's conversation, messages and missions follow the customer (feature kept), the guest is deleted", async () => {
    state.user = USERS[ATTACKER];
    await send(realPost, `gst_${GUEST}`);
    expect(owner("conversations", "cv_guest")).toBe(ATTACKER);
    expect(owner("messages", "m_guest")).toBe(ATTACKER);
    expect(owner("missions", "msn_guest")).toBe(ATTACKER);
    expect(deleted).toEqual([GUEST]);
    expect(owner("missions", "msn_victim")).toBe(VICTIM);
  });

  it("SIGNED IN + an old-style cookie that names no account: its hash-pseudo rows still follow the customer", async () => {
    state.user = USERS[ATTACKER];
    const { createHash } = await import("node:crypto");
    const h = createHash("sha256").update("guest_session:legacy-cookie").digest("hex");
    const pseudo = [h.substring(0, 8), h.substring(8, 12), "4" + h.substring(13, 16), ((parseInt(h.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) + h.substring(18, 20), h.substring(20, 32)].join("-");
    db.seed("conversations", [{ id: "cv_pseudo", user_id: pseudo }]);
    await send(realPost, "legacy-cookie");
    expect(owner("conversations", "cv_pseudo")).toBe(ATTACKER);
  });

  it("NOT SIGNED IN + cookie naming a real customer: the request is NOT run as that customer (a fresh guest is made, the customer's rows are untouched)", async () => {
    state.user = null;
    const res = await send(realPost, `gst_${VICTIM}`, { isGuest: true });
    expect(res.status).toBeLessThan(500);
    expect(created, "a fresh guest account was made instead").toBe(1);
    for (const t of ["missions", "conversations", "messages"]) expect(db.rows(t).filter((r: any) => r.user_id === VICTIM), `${t}: only the seeded customer row`).toHaveLength(1);
    expect(db.rows("conversations").length + db.rows("messages").length, "the request wrote something, under another id").toBeGreaterThan(4);
  });

  it("NOT SIGNED IN + cookie naming a real customer + guest creation failing: the hash-pseudo id is used, never the customer's id", async () => {
    world({ createFails: true });
    state.user = null;
    await send(realPost, `gst_${VICTIM}`, { isGuest: true });
    for (const t of ["missions", "conversations", "messages"]) expect(db.rows(t).filter((r: any) => r.user_id === VICTIM), `${t}`).toHaveLength(1);
    expect(db.rows("conversations").length + db.rows("messages").length, "the request wrote something, under another id").toBeGreaterThan(4);
  });

  it("guest creation failing: the SAME browser keeps ONE identity across turns (cookie hashed every time)", async () => {
    world({ createFails: true });
    state.user = null;
    const first = await send(realPost, null, { isGuest: true });
    const cookie = /guest_session_id=([^;]+)/.exec(first.headers.get("set-cookie") ?? "")?.[1];
    expect(cookie).toMatch(/^gst_/);
    const before = new Set(db.rows("messages").map((r: any) => r.user_id));
    await send(realPost, decodeURIComponent(cookie!), { isGuest: true });
    const after = new Set(db.rows("messages").map((r: any) => r.user_id));
    expect(after.size, "no second identity appeared").toBe(before.size);
  });

  it("NOT SIGNED IN + the guest's own cookie: the same guest continues (no new account)", async () => {
    state.user = null;
    await send(realPost, `gst_${GUEST}`, { isGuest: true });
    expect(created).toBe(0);
  });
});

describe("MUTATION: each part of the fix, removed alone, re-opens the takeover", () => {
  const ROUTE = "src/app/api/chat/route.ts";
  const HELPER = "src/lib/server/guestIdentity.ts";
  const MIGRATE_FROM = "? await ownGuestAccountId(tables, guestSessionCookie)\n          : guestSessionToUuid(guestSessionCookie);";
  const takeover = async (post: typeof realPost) => { world(); state.user = USERS[ATTACKER]; await send(post, `gst_${VICTIM}`); return { moved: owner("missions", "msn_victim") === ATTACKER, deletedVictim: deleted.includes(VICTIM) }; };

  it("baseline: the real route refuses", async () => {
    expect(await takeover(realPost)).toEqual({ moved: false, deletedVictim: false });
  });
  it("migrating on the raw cookie id (no guest check) moves the victim's missions and deletes the account", async () => {
    const m = await loadMutant(ROUTE, [{ from: MIGRATE_FROM, to: "? guestUuidOfCookie(guestSessionCookie)\n          : guestSessionToUuid(guestSessionCookie);" }]);
    expect(await takeover(m.module.POST), "mutant takes over").toEqual({ moved: true, deletedVictim: true });
  });
  it("adopting any existing user in the not-signed-in branch acts as the victim", async () => {
    const m = await loadMutant(ROUTE, [{ from: "const existingGuestId: string | null = await ownGuestAccountId(tables, guestSessionCookie);", to: "const existingGuestId: string | null = guestUuidOfCookie(guestSessionCookie);" }]);
    world(); state.user = null;
    await send(m.module.POST, `gst_${VICTIM}`, { isGuest: true });
    expect(created, "the mutant reused the victim's id (no guest made)").toBe(0);
  });
  it("trusting the raw cookie id in the fallback acts as the victim when guest creation fails", async () => {
    const m = await loadMutant(ROUTE, [{ from: "verifiedUserId = guestSessionToUuid(guestSessionCookie);", to: "verifiedUserId = guestUuidOfCookie(guestSessionCookie) ?? guestSessionToUuid(guestSessionCookie);" }]);
    world({ createFails: true }); state.user = null;
    await send(m.module.POST, `gst_${VICTIM}`, { isGuest: true });
    expect(db.rows("conversations").filter((r: any) => r.user_id === VICTIM).length, "the mutant wrote under the victim's id").toBeGreaterThan(1);
  });
  it("dropping the 'not the caller's own id' guard lets a customer carrying their own id as cookie delete themselves", async () => {
    const m = await loadMutant(ROUTE, [{ from: "if (prevGuestUuid && prevGuestUuid !== verifiedUserId) try {", to: "if (prevGuestUuid) try {" }]);
    world(); state.user = USERS[GUEST]; // a guest upgraded in place: signed in as the account the cookie names
    await send(m.module.POST, `gst_${GUEST}`);
    expect(deleted, "the mutant deletes the signed-in account").toContain(GUEST);
    world(); state.user = USERS[GUEST];
    await send(realPost, `gst_${GUEST}`);
    expect(deleted, "the real route never deletes the account it is serving").toEqual([]);
  });
  it("dropping the 'unconfirmed address' rule makes a confirmed customer disposable", async () => {
    const m = await loadMutant(HELPER, [{ from: "if (user.email_confirmed_at) return false;", to: "" }]);
    expect(m.module.isDisposableGuestAccount({ ...USERS[GUEST], email_confirmed_at: "2026-11-01T00:00:00Z" })).toBe(true);
  });
  it("dropping the generated-address rule lets a self-marked account be disposable", async () => {
    const m = await loadMutant(HELPER, [{ from: "return typeof user.email === \"string\" && GUEST_EMAIL_RE.test(user.email);", to: "return true;" }]);
    expect(m.module.isDisposableGuestAccount({ email: "someone@example.com", email_confirmed_at: null, user_metadata: { is_guest: true } })).toBe(true);
  });
  it("accepting a lookup for another id makes a mismatched answer count", async () => {
    const m = await loadMutant(HELPER, [{ from: "return user?.id === uuid && isDisposableGuestAccount(user) ? uuid : null;", to: "return isDisposableGuestAccount(user) ? uuid : null;" }]);
    world();
    (db.auth.admin as any).getUserById = async () => ({ data: { user: { ...USERS[GUEST], id: VICTIM } } });
    expect(await m.module.ownGuestAccountId(db, `gst_${GUEST}`)).toBe(GUEST);
  });
});

describe("the other readers of the same cookie", () => {
  const MV = "src/lib/server/missionViewer.ts";
  const viewerReq = (cookie: string) => new NextRequest("https://diger.test/api/missions/msn_abcdefgh12", { headers: { cookie: `guest_session_id=${cookie}` } });
  beforeEach(() => { world(); state.user = null; });

  it("missionViewer: a disposable guest's cookie gives the guest's own view", async () => {
    const { resolveMissionViewer } = await import("../src/lib/server/missionViewer");
    const r: any = await resolveMissionViewer(viewerReq(`gst_${GUEST}`));
    expect(r.ok).toBe(true);
    expect(r.viewer).toMatchObject({ userId: GUEST, isGuest: true, emailVerified: false });
  });
  it("missionViewer: a cookie naming a real customer, or one who wrote is_guest on their own account, gets nothing", async () => {
    const { resolveMissionViewer } = await import("../src/lib/server/missionViewer");
    for (const id of [VICTIM, FAKE_GUEST]) expect(((await resolveMissionViewer(viewerReq(`gst_${id}`))) as any).ok, id).toBe(false);
  });
  it("MUTATION: reading only the metadata mark in missionViewer shows a customer's missions to anyone with the id", async () => {
    const m = await loadMutant(MV, [{ from: "const guestId = await ownGuestAccountId(createAdminClient(), `gst_${match[1]}`);", to: "const guestId = (await createAdminClient().auth.admin.getUserById(match[1])).data?.user?.user_metadata?.is_guest ? match[1] : null;" }]);
    const r: any = await m.module.resolveMissionViewer(viewerReq(`gst_${FAKE_GUEST}`));
    expect(r.ok, "the mutant admits the self-marked customer").toBe(true);
  });
  it("watchdog: purges only disposable guests, never a customer who wrote is_guest themselves", async () => {
    const old = "2026-10-01T00:00:00Z";
    const list = [{ ...USERS[GUEST], created_at: old }, { ...USERS[FAKE_GUEST], created_at: old }, { ...USERS[VICTIM], created_at: old }];
    (db.auth.admin as any).listUsers = async () => ({ data: { users: list } });
    // every table read answers "nothing": only the guest clean-up step is under test
    const chain: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? (res: any) => res({ data: [], error: null, count: 0 }) : chain), apply: () => chain });
    (db as any).from = () => chain;
    process.env.CRON_SECRET = "s3cret";
    const { GET } = await import("../src/app/api/cron/watchdog/route");
    await GET(new NextRequest("https://diger.test/api/cron/watchdog", { headers: { authorization: "Bearer s3cret" } }));
    expect(deleted).toEqual([GUEST]);
  });
});
