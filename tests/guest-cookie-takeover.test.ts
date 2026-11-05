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

  it("NOT SIGNED IN + cookie naming a real customer: the request is NOT run as that customer", async () => {
    state.user = null;
    const res = await send(realPost, `gst_${VICTIM}`, { isGuest: true });
    expect(res.status).toBeLessThan(500);
    const owners = new Set(db.rows("missions").map((r: any) => r.user_id));
    expect([...db.rows("conversations"), ...db.rows("messages"), ...db.rows("missions")].filter((r: any) => !String(r.id).endsWith("victim") && !String(r.id).endsWith("guest")).every((r: any) => r.user_id !== VICTIM)).toBe(true);
    expect(created, "a fresh guest account was made instead").toBe(1);
    expect(owners.has(VICTIM)).toBe(true); // only the pre-existing victim mission
    expect(db.rows("missions").filter((r: any) => r.user_id === VICTIM)).toHaveLength(1);
  });

  it("NOT SIGNED IN + cookie naming a real customer + guest creation failing: the hash-pseudo id is used, never the customer's id", async () => {
    world({ createFails: true });
    state.user = null;
    await send(realPost, `gst_${VICTIM}`, { isGuest: true });
    expect(db.rows("missions").filter((r: any) => r.user_id === VICTIM)).toHaveLength(1);
    expect(db.rows("conversations").filter((r: any) => r.user_id === VICTIM)).toHaveLength(1);
    expect(db.rows("messages").filter((r: any) => r.user_id === VICTIM)).toHaveLength(1);
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
    const m = await loadMutant(ROUTE, [{ from: "const generatedHere = guestSessionCookie === newGuestCookieToSet ? guestUuidOfCookie(guestSessionCookie) : null;", to: "const generatedHere = guestUuidOfCookie(guestSessionCookie);" }]);
    world({ createFails: true }); state.user = null;
    await send(m.module.POST, `gst_${VICTIM}`, { isGuest: true });
    expect(db.rows("conversations").filter((r: any) => r.user_id === VICTIM).length, "the mutant wrote under the victim's id").toBeGreaterThan(1);
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
