import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cleanMutants, loadMutant } from "./helpers/mutants";

/**
 * MUTATION TESTS for the e-mail verification guards that authorize approval, payment and top-ups. Each removes ONE protection from a COPY of the source
 * (tests/helpers/mutants.ts: the real files are never edited; the copies are deleted afterwards) and shows that the forged-flag guarantee BREAKS.
 * A mutation that no longer applies fails loudly. Fake sign-in service only: no network, no money.
 */
const state = vi.hoisted(() => ({ user: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user }, error: null }) } }),
  createAdminClient: () => ({ auth: { admin: { getUserById: async () => ({ data: { user: null } }) } } }),
}));
afterAll(cleanMutants);
const TRUSTED = "src/lib/server/trustedEmailVerification.ts";
const VIEWER = "src/lib/server/missionViewer.ts";
const CLAIMS = "src/lib/server/localClaims.ts";
const forged = { id: "u-forged", email: "f@b.c", email_confirmed_at: null, user_metadata: { email_verified: true } };
const req = () => new NextRequest("https://diger.test/api/missions/msn_abcdefgh12/approve", { method: "POST" });

describe("MUTATION: the verification guards", () => {
  it("baseline: the real resolver refuses a forged flag", async () => {
    const real = await import("../src/lib/server/missionViewer");
    state.user = forged;
    const r: any = await real.resolveMissionViewer(req());
    expect(r.viewer.emailVerified).toBe(false);
  });

  it("if the helper also read user_metadata.email_verified, a forged flag would be accepted", async () => {
    const m = await loadMutant(TRUSTED, [{ from: "return Boolean(user.email_confirmed_at);", to: "return Boolean(user.email_confirmed_at || (user as any).user_metadata?.email_verified);" }]);
    expect(m.module.isEmailConfirmedByAuth(forged), "the mutant accepts the forged flag").toBe(true);
  });

  it("if the local-claims marker were ignored, a locally rebuilt user would count without the service's word", async () => {
    const m = await loadMutant(TRUSTED, [{ from: "if (!user || user.__localClaims) return false;", to: "if (!user) return false;" }]);
    expect(m.module.isEmailConfirmedByAuth({ email_confirmed_at: "2026-11-01T00:00:00Z", __localClaims: true }), "the mutant trusts a locally rebuilt user").toBe(true);
  });

  it("if a locally rebuilt user needed no service answer, the forged flag would pass on the AUTH_LOCAL_CLAIMS path", async () => {
    const m = await loadMutant(TRUSTED, [{ from: "  if (!user.__localClaims) return isEmailConfirmedByAuth(user);\n  const fromService", to: "  if (!user.__localClaims) return isEmailConfirmedByAuth(user);\n  return true;\n  const fromService" }]);
    expect(await m.module.resolveTrustedEmailVerified({ auth: {} }, { __localClaims: true }), "the mutant says verified without asking the service").toBe(true);
    const real = await import("../src/lib/server/trustedEmailVerification");
    expect(await real.resolveTrustedEmailVerified({ auth: {} }, { __localClaims: true })).toBe(false);
  });

  it("if confirmed_at (which a phone confirmation also sets) counted, a phone-only account would pass as e-mail verified", async () => {
    const m = await loadMutant(TRUSTED, [{ from: "return Boolean(user.email_confirmed_at);", to: "return Boolean(user.email_confirmed_at || (user as any).confirmed_at);" }]);
    expect(m.module.isEmailConfirmedByAuth({ confirmed_at: "2026-11-01T00:00:00Z" }), "the mutant accepts a phone confirmation").toBe(true);
  });

  it("without the same-account check, the service's answer about ANOTHER account would verify this one", async () => {
    const m = await loadMutant(TRUSTED, [{ from: '    if ((data.user as { id?: string }).id !== (user as { id?: string }).id) return false;\n', to: "" }]);
    const svc = { auth: { getUserFromService: async () => ({ data: { user: { id: "someone-else", email_confirmed_at: "2026-11-01T00:00:00Z" } }, error: null }) } };
    expect(await m.module.resolveTrustedEmailVerified(svc, { id: "u1", __localClaims: true })).toBe(true);
    const real = await import("../src/lib/server/trustedEmailVerification");
    expect(await real.resolveTrustedEmailVerified(svc, { id: "u1", __localClaims: true })).toBe(false);
  });

  it("if the service's failure counted as «verified», an unreachable service would verify everyone", async () => {
    const m = await loadMutant(TRUSTED, [{ from: "    if (error || !data?.user) return false;", to: "    if (error || !data?.user) return true;" }]);
    expect(await m.module.resolveTrustedEmailVerified({ auth: { getUserFromService: async () => ({ data: null, error: { message: "down" } }) } }, { __localClaims: true })).toBe(true);
  });

  it("if the claims rebuild minted a confirmation time from metadata again, the forged flag would be trusted by every reader", async () => {
    const m = await loadMutant(CLAIMS, [{ from: "    email_confirmed_at: undefined,\n    __localClaims: true,", to: "    email_confirmed_at: metadata.email_verified === true ? new Date().toISOString() : undefined,\n    __localClaims: true," }]);
    const u = m.module.userFromClaims({ sub: "u1", user_metadata: { email_verified: true } });
    expect(u.email_confirmed_at, "the mutant mints a confirmation from the forged flag").toBeTruthy();
  });

  it("if missionViewer read the metadata itself again, a forged flag would let a customer approve", async () => {
    const m = await loadMutant(VIEWER, [{ from: "emailVerified: await resolveTrustedEmailVerified(supabase, user, token)", to: "emailVerified: Boolean(user.email_confirmed_at || user.user_metadata?.email_verified)" }]);
    state.user = forged;
    const r: any = await m.module.resolveMissionViewer(req());
    expect(r.viewer.emailVerified, "the mutant's viewer is verified by a forged flag").toBe(true);
  });
});
