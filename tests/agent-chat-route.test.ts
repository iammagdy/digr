import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";

const state = vi.hoisted(() => ({ user: null as any, db: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })), updateUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.db),
}));
// the chat route, with the rollback constant as shipped (true): no pin here
import { POST } from "../src/app/api/chat/route";
import { AGENT_SERVES_CHAT } from "../src/lib/agentMission/constants";

const post = (body: unknown, extra: Record<string, string> = {}) => POST(new NextRequest("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...extra } }));

describe("POST /api/chat with the agent on (the constant as shipped)", () => {
  let db: MemoryDb;
  beforeEach(() => { db = createMemoryDb(); state.db = db; db.seed("profiles", [{ id: "u1", email: "a@example.com" }]); });

  it("a signed-in customer's research request becomes a mission and the answer carries its id", async () => {
    expect(AGENT_SERVES_CHAT).toBe(true);
    state.user = { id: "u1", email: "a@example.com", email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} };
    const res = await post({ message: "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, outputType: "agent_mission" });
    expect(body.agentMission.id).toMatch(/^msn_/);
    expect(db.rows("missions")[0]).toMatchObject({ user_id: "u1", status: "queued" });
  });

  it("a guest's request becomes a mission of the guest (who must sign up to approve); the guest's account is real, so nothing is lost at sign-up", async () => {
    state.user = null;
    (db.auth.admin as any).createUser = async () => ({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } }, error: null });
    const res = await post({ message: "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا", isGuest: true });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, isGuest: true, outputType: "agent_mission" });
    expect(db.rows("missions")[0]).toMatchObject({ user_id: "11111111-1111-4111-8111-111111111111", status: "queued" });
  });
});
