import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  admin: true,
  audit: [] as any[],
  users: {} as Record<string, { email: string; user_metadata?: Record<string, unknown> }>,
  missions: {} as Record<string, any>,
  storage: {} as Record<string, Buffer>,
  testAccountId: "test-acc",
}));

vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (state.admin
    ? { ok: true, ctx: { adminId: "adm-1", audit: vi.fn(async (...args: any[]) => { state.audit.push(args); }) } }
    : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));

function table(name: string) {
  const f: Record<string, unknown> = {};
  const chain: any = {
    select: () => chain,
    eq: (k: string, v: unknown) => { f[k] = v; return chain; },
    order: () => chain,
    limit: async () => ({ data: name === "missions" ? Object.values(state.missions).filter((m) => m.user_id === f.user_id) : [], error: null }),
    maybeSingle: async () => {
      if (name === "missions") return { data: state.missions[String(f.id)] ?? null, error: null };
      if (name === "profiles") return { data: { id: state.testAccountId, email: f.email }, error: null };
      return { data: null, error: null };
    },
  };
  return chain;
}
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(),
  createAdminClient: () => ({
    from: (name: string) => table(name),
    storage: { from: () => ({ download: async (path: string) => (state.storage[path] ? { data: new Blob([new Uint8Array(state.storage[path])]), error: null } : { data: null, error: { message: "nf" } }) }) },
    auth: { admin: { getUserById: async (id: string) => (state.users[id] ? { data: { user: { ...state.users[id], created_at: "2026-10-01T00:00:00Z" } }, error: null } : { data: { user: null }, error: { message: "nf" } }) } },
  }),
}));

import { GET, POST } from "../src/app/api/admin/users/[id]/email/route";
import { CUSTOMER_MESSAGE_PRESETS, isSitePath, renderCustomerMessageHtml, renderCustomerMessageText, validateCustomerMessage } from "../src/lib/customerMessage";

const CUSTOMER = "cust-1";
const OTHER = "cust-2";
const ctx = (id = CUSTOMER) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, id = CUSTOMER) => POST(new NextRequest(`http://localhost/api/admin/users/${id}/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx(id));
const good = { subject: "بخصوص طلبك الأخير", badge: "تحديث", heading: "نعتذر عن تعثّر طلبك", body: "د. هالة، تحية طيبة،\nنعتذر.\n\nيمكنك إعادة الطلب الآن.", ctaLabel: "إعادة إرسال الطلب", ctaPath: "/dashboard/chat" };
const mission = (id: string, userId: string) => ({ id, user_id: userId, files: [{ name: "result.xlsx", path: "result.xlsx", kind: "xlsx" }], plan: null, request_text: "سحب تعليقات على ريدت", delivered_units: 9, updated_at: "2026-11-09T18:00:00Z", status: "completed", created_at: "2026-11-09T17:00:00Z" });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  state.admin = true; state.audit = [];
  state.users = { [CUSTOMER]: { email: "hala@example.com", user_metadata: { name: "د. هالة" } }, [OTHER]: { email: "other@example.com" } };
  state.missions = { msn_aaaaaaaaaaaa: mission("msn_aaaaaaaaaaaa", CUSTOMER), msn_bbbbbbbbbbbb: mission("msn_bbbbbbbbbbbb", OTHER), msn_cccccccccccc: mission("msn_cccccccccccc", "test-acc") };
  state.storage = { "msn_aaaaaaaaaaaa/result.xlsx": Buffer.from("xlsx-own"), "msn_bbbbbbbbbbbb/result.xlsx": Buffer.from("xlsx-other"), "msn_cccccccccccc/result.xlsx": Buffer.from("xlsx-test") };
  process.env.RESEND_API_KEY = "re_test";
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.RESEND_API_KEY; });

describe("the message: validated, escaped, in the platform's design", () => {
  it("a button may open a page of the site only", () => {
    expect(isSitePath("/dashboard/chat")).toBe(true);
    for (const bad of ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/\\evil", "/ space", "dashboard"]) expect(isSitePath(bad), bad).toBe(false);
    expect(validateCustomerMessage({ ...good, ctaPath: "https://evil.example" })).toMatchObject({ ok: false });
    expect(validateCustomerMessage({ ...good, ctaPath: "" })).toMatchObject({ ok: false });
    expect(validateCustomerMessage({ ...good, ctaLabel: "", ctaPath: "" })).toMatchObject({ ok: true });
    expect(validateCustomerMessage({ ...good, subject: "x" })).toMatchObject({ ok: false });
  });

  it("every text is escaped; paragraphs and line breaks are kept; the wordmark, the button and the footer are the platform's", () => {
    const v = validateCustomerMessage({ ...good, heading: "<script>alert(1)</script> عنوان", body: "أ <b>ب</b>\nسطر\n\nفقرة" });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const html = renderCustomerMessageHtml(v.value, { siteUrl: "https://diger.tech" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("أ &lt;b&gt;ب&lt;/b&gt;<br>سطر</p>");
    expect(html).toContain(">فقرة</p>");
    expect(html).toContain('src="https://diger.tech/email/digr-wordmark.png"');
    expect(html).toContain('href="https://diger.tech/dashboard/chat"');
    expect(html).toContain("support@diger.tech");
    expect(renderCustomerMessageText(v.value)).toContain("إعادة إرسال الطلب: https://diger.tech/dashboard/chat");
  });

  it("the ready texts are valid messages", () => {
    for (const p of CUSTOMER_MESSAGE_PRESETS) expect(validateCustomerMessage(p.build({ name: "د. هالة" })).ok, p.id).toBe(true);
  });
});

describe("the admin route: who it goes to, what may be attached", () => {
  it("admins only", async () => {
    state.admin = false;
    expect((await post({ ...good, action: "preview" })).status).toBe(403);
  });

  it("GET gives the registered address and the customer's missions that have a file", async () => {
    const r = await GET(new NextRequest(`http://localhost/api/admin/users/${CUSTOMER}/email`), ctx());
    const j = await r.json();
    expect(j.email).toBe("hala@example.com");
    expect(j.missions.map((m: any) => m.id)).toEqual(["msn_aaaaaaaaaaaa"]);
  });

  it("preview sends nothing", async () => {
    const r = await post({ ...good, action: "preview" });
    expect(r.status).toBe(200);
    expect((await r.json()).to).toBe("hala@example.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("send goes to the REGISTERED address only (a `to` in the body is ignored), from noreply with replies to support, once per key, and is audited", async () => {
    const r = await post({ ...good, action: "send", to: "attacker@example.com", idempotencyKey: "key-12345678" });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const sent = JSON.parse(String(init.body));
    expect(sent.to).toEqual(["hala@example.com"]);
    expect(sent.from).toBe("Diger <noreply@diger.tech>");
    expect(sent.reply_to).toBe("support@diger.tech");
    expect(sent.subject).toBe(good.subject);
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(`admin-mail:${CUSTOMER}:key-12345678`);
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0][3]).toMatchObject({ targetType: "user", targetId: CUSTOMER });
  });

  it("send needs a send key", async () => {
    expect((await post({ ...good, action: "send" })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("attaches the file of the customer's own mission, or of a test-account mission; never another customer's", async () => {
    const own = await post({ ...good, action: "send", idempotencyKey: "key-own-0001", missionId: "msn_aaaaaaaaaaaa" });
    expect(own.status).toBe(200);
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.attachments).toHaveLength(1);
    expect(Buffer.from(sent.attachments[0].content, "base64").toString()).toBe("xlsx-own");
    expect(sent.attachments[0].filename).toMatch(/\.xlsx$/);

    expect((await post({ ...good, action: "send", idempotencyKey: "key-test-0001", missionId: "msn_cccccccccccc" })).status).toBe(200);

    const other = await post({ ...good, action: "send", idempotencyKey: "key-other-001", missionId: "msn_bbbbbbbbbbbb" });
    expect(other.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an add-on row (a review or an edit of a delivered file) is never listed nor attached", async () => {
    state.missions.msn_dddddddddddd = { ...mission("msn_dddddddddddd", CUSTOMER), addon: { kind: "edit" } };
    state.storage["msn_dddddddddddd/result.xlsx"] = Buffer.from("xlsx-addon");
    const j = await (await GET(new NextRequest(`http://localhost/api/admin/users/${CUSTOMER}/email`), ctx())).json();
    expect(j.missions.map((m: any) => m.id)).not.toContain("msn_dddddddddddd");
    expect((await post({ ...good, action: "send", idempotencyKey: "key-addon-001", missionId: "msn_dddddddddddd" })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("without the Resend key nothing is sent and the admin is told why", async () => {
    delete process.env.RESEND_API_KEY;
    const r = await post({ ...good, action: "send", idempotencyKey: "key-12345678" });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/Resend/);
    expect(state.audit).toHaveLength(0);
  });

  it("a rejected send is not audited as sent", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 422 }));
    const r = await post({ ...good, action: "send", idempotencyKey: "key-12345678" });
    expect(r.status).toBe(502);
    expect(state.audit).toHaveLength(0);
  });
});
