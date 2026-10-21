import { afterEach, describe, expect, it, vi } from "vitest";
import { localClaimsEnabled, userFromClaims, withLocalClaims } from "../src/lib/server/localClaims";

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

function client(claimsResult: any) {
  const calls = { getUser: 0, getClaims: 0 };
  const auth: any = {
    getUser: vi.fn(async () => { calls.getUser += 1; return { data: { user: { id: "from-service" } }, error: null }; }),
    getClaims: vi.fn(async () => { calls.getClaims += 1; if (claimsResult instanceof Error) throw claimsResult; return claimsResult; }),
  };
  return { client: { auth }, calls };
}
const goodClaims = { data: { claims: { sub: "u1", email: "a@b.c", iat: 1_790_000_000, app_metadata: { role: "admin" }, user_metadata: { email_verified: true, name: "x" } } }, error: null };

describe("a readable token is answered locally, only when the owner turned it on", () => {
  it("off by default: the client is untouched and every check asks the sign-in service", async () => {
    delete process.env.AUTH_LOCAL_CLAIMS;
    expect(localClaimsEnabled()).toBe(false);
    const { client: c, calls } = client(goodClaims);
    const original = c.auth.getUser;
    withLocalClaims(c);
    expect(c.auth.getUser).toBe(original);
    await c.auth.getUser("jwt");
    expect(calls).toEqual({ getUser: 1, getClaims: 0 });
  });

  it("on: a readable token gives the same fields the server reads, and no call to the service", async () => {
    process.env.AUTH_LOCAL_CLAIMS = "on";
    const { client: c, calls } = client(goodClaims);
    withLocalClaims(c);
    const { data, error } = await c.auth.getUser("jwt");
    expect(error).toBeNull();
    expect(data.user).toMatchObject({ id: "u1", email: "a@b.c", app_metadata: { role: "admin" }, user_metadata: { email_verified: true } });
    expect(data.user.email_confirmed_at).toBeTruthy();
    expect(calls).toEqual({ getUser: 0, getClaims: 1 });
  });

  it("an unconfirmed e-mail is still unconfirmed", () => {
    expect(userFromClaims({ sub: "u2", user_metadata: { email_verified: false } }).email_confirmed_at).toBeUndefined();
    expect(userFromClaims({ sub: "u2" }).email_confirmed_at).toBeUndefined();
  });

  it("an unreadable, expired or missing token falls back to the service, which judges it as before", async () => {
    process.env.AUTH_LOCAL_CLAIMS = "on";
    for (const result of [{ data: null, error: { message: "bad" } }, { data: { claims: null }, error: null }, { data: { claims: {} }, error: null }, new Error("jwks down")]) {
      const { client: c, calls } = client(result);
      withLocalClaims(c);
      const { data } = await c.auth.getUser("jwt");
      expect(data.user.id).toBe("from-service");
      expect(calls.getUser).toBe(1);
    }
  });

  it("a client without getClaims (older library, test double) is left alone, and wrapping twice does not stack", async () => {
    process.env.AUTH_LOCAL_CLAIMS = "on";
    const bare: any = { auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) } };
    const before = bare.auth.getUser;
    withLocalClaims(bare);
    expect(bare.auth.getUser).toBe(before);
    const { client: c, calls } = client(goodClaims);
    withLocalClaims(withLocalClaims(c));
    await c.auth.getUser();
    expect(calls.getClaims).toBe(1);
  });
});
