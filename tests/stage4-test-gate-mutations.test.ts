import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanMutants, loadMutant } from "./helpers/mutants";

/**
 * MUTATION TESTS for the Stage 4 test-account gate (authorization guards). Each test removes ONE protection from a COPY of testGate.ts (tests/helpers/mutants.ts: the real file is never edited,
 * the copies are deleted afterwards) and shows that the guarantee BREAKS. A mutation that no longer applies fails loudly. Fake only: no network, no sign-in service, no money.
 */
vi.mock("../src/lib/supabase/server", () => ({ createServerSideClient: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: { message: "no" } }) } }), createAdminClient: () => ({}) }));
afterAll(cleanMutants);
const FILE = "src/lib/agentMission/stage4/testGate.ts";
const LISTED = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const env = { DIGER_STAGE4_TEST_USER_IDS: LISTED, DIGER_STAGE4_APPROVAL: "allowlist" };
const good = { userId: LISTED, isGuest: false, emailVerified: true };
const GUARD = 'if (!viewer || viewer.isGuest || viewer.emailVerified !== true || typeof viewer.userId !== "string") return false;';
const MEMBER = "return stage4TestUserIds(env).has(viewer.userId.trim().toLowerCase());";

describe("MUTATION: the gate's guards (each must be what keeps the guarantee)", () => {
  it("the real module: only the listed, verified, non-guest customer is authorized (baseline)", async () => {
    const real = await import("../src/lib/agentMission/stage4/testGate");
    expect(real.isStage4TestViewer(good, env)).toBe(true);
    expect(real.isStage4TestViewer({ ...good, isGuest: true }, env)).toBe(false);
    expect(real.isStage4TestViewer({ ...good, emailVerified: false }, env)).toBe(false);
    expect(real.isStage4TestViewer({ ...good, userId: OTHER }, env)).toBe(false);
  });
  it("without the GUEST check a guest account on the list is authorized", async () => {
    const m = await loadMutant(FILE, [{ from: GUARD, to: 'if (!viewer || viewer.emailVerified !== true || typeof viewer.userId !== "string") return false;' }]);
    expect(m.module.isStage4TestViewer({ ...good, isGuest: true }, env), "the mutant serves a guest").toBe(true);
  });
  it("without the VERIFIED-e-mail check an unverified account on the list is authorized", async () => {
    const m = await loadMutant(FILE, [{ from: GUARD, to: 'if (!viewer || viewer.isGuest || typeof viewer.userId !== "string") return false;' }]);
    expect(m.module.isStage4TestViewer({ ...good, emailVerified: false }, env), "the mutant serves an unverified account").toBe(true);
  });
  it("without the ALLOWLIST membership test every verified customer is authorized (financial approval exposed to all)", async () => {
    const m = await loadMutant(FILE, [{ from: MEMBER, to: "return true;" }]);
    expect(m.module.isStage4TestViewer({ ...good, userId: OTHER }, env), "the mutant serves a customer who is not on the list").toBe(true);
  });
  it("if an EMPTY allowlist meant «everybody», an unset variable would expose approval to all customers", async () => {
    const m = await loadMutant(FILE, [{ from: MEMBER, to: "{ const ids = stage4TestUserIds(env); return ids.size === 0 || ids.has(viewer.userId.trim().toLowerCase()); }" }]);
    expect(m.module.isStage4TestViewer({ ...good, userId: OTHER }, {}), "the mutant serves everybody on an empty list").toBe(true);
    const real = await import("../src/lib/agentMission/stage4/testGate");
    expect(real.isStage4TestViewer({ ...good, userId: OTHER }, {})).toBe(false);
  });
  it("without the UUID filter an e-mail or a wildcard written in the list is accepted as an identity", async () => {
    const m = await loadMutant(FILE, [{ from: ".filter((x) => UUID.test(x))", to: ".filter((x) => x.length > 0)" }]);
    expect(m.module.stage4TestUserIds({ DIGER_STAGE4_TEST_USER_IDS: "*, iam.magdy@outlook.com" }).size, "the mutant keeps non-UUID entries").toBe(2);
    const real = await import("../src/lib/agentMission/stage4/testGate");
    expect(real.stage4TestUserIds({ DIGER_STAGE4_TEST_USER_IDS: "*, iam.magdy@outlook.com" }).size).toBe(0);
  });
  it("without the «allowlist» mode check a flag that is OFF would still serve a listed account", async () => {
    const m = await loadMutant(FILE, [{ from: "return stage4AllowlistMode(flag, env) && isStage4TestViewer(viewer, env);", to: "return isStage4TestViewer(viewer, env);" }]);
    expect(m.module.stage4ServedTo("DIGER_STAGE4_APPROVAL", good, { ...env, DIGER_STAGE4_APPROVAL: "" }), "the mutant serves while OFF").toBe(true);
    const real = await import("../src/lib/agentMission/stage4/testGate");
    expect(real.stage4ServedTo("DIGER_STAGE4_APPROVAL", good, { ...env, DIGER_STAGE4_APPROVAL: "" })).toBe(false);
  });
  it("lower-casing is part of the identity match: without it an upper-case id would never match (fail-closed, but the list is documented as case-insensitive)", async () => {
    const real = await import("../src/lib/agentMission/stage4/testGate");
    expect(real.isStage4TestViewer({ ...good, userId: LISTED.toUpperCase() }, env)).toBe(true);
  });
});
