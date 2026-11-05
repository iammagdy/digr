import type { NextRequest } from "next/server";
import { resolveMissionViewer, type MissionViewer } from "@/lib/server/missionViewer";
import { stage4AllowlistMode, stage4FlagMode, type Stage4Flag } from "./flags";

/**
 * STAGE 4 TEST-ACCOUNT GATE (server only). A Stage 4 flag set to exactly «allowlist» serves its routes ONLY to explicitly authorized test accounts; «on» serves everyone (unchanged); «test» and anything else stay OFF for the site (unchanged).
 *
 * WHO is authorized is decided by ONE thing: the account's immutable USER ID (the sign-in service's `user.id`, read from the verified token by `resolveMissionViewer`), compared with the
 * SERVER-ONLY allowlist in the environment variable DIGER_STAGE4_TEST_USER_IDS (comma or space separated UUIDs). Nothing the customer can edit is ever consulted:
 *   - not `user_metadata` (writable by the customer), not an e-mail address or a domain, not a request header, query, cookie or body field, not a database column the customer can write;
 *   - the account must ALSO be a signed-in, non-guest, e-mail-verified customer (the service's own confirmation: trustedEmailVerification.ts).
 * The allowlist is never sent to the browser: the variable has no NEXT_PUBLIC_ prefix, this module is imported only by API routes and server libraries (tests/stage4-test-gate.test.ts pins both), and a refusal looks EXACTLY like the feature being off:
 * a plain 404 «not_found» for the unauthenticated, the guest, the unverified and the signed-in customer who is not on the list. Nothing says that a gate, a list or a test mode exists.
 * An empty, missing or malformed allowlist authorizes NOBODY (never «everybody»); an entry that is not a UUID is ignored.
 */
export const STAGE4_TEST_USERS_ENV = "DIGER_STAGE4_TEST_USER_IDS";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Env = Readonly<Record<string, string | undefined>>;
const processEnv = (): Env => (typeof process !== "undefined" && process.env ? process.env : {});

/** The authorized user ids (lower-cased UUIDs only). */
export function stage4TestUserIds(env: Env = processEnv()): ReadonlySet<string> {
  return new Set(String(env[STAGE4_TEST_USERS_ENV] ?? "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => UUID.test(x)));
}

/** True only for a signed-in, non-guest, verified customer whose user id is on the allowlist. */
export function isStage4TestViewer(viewer: Pick<MissionViewer, "userId" | "isGuest" | "emailVerified"> | null | undefined, env: Env = processEnv()): boolean {
  if (!viewer || viewer.isGuest || viewer.emailVerified !== true || typeof viewer.userId !== "string") return false;
  return stage4TestUserIds(env).has(viewer.userId.trim().toLowerCase());
}

/** Is `flag` served to this viewer? `on` for everyone (no look at the viewer), `allowlist` for an authorized test viewer, anything else never. */
export function stage4ServedTo(flag: Stage4Flag, viewer: Pick<MissionViewer, "userId" | "isGuest" | "emailVerified"> | null | undefined, env: Env = processEnv()): boolean {
  const mode = stage4FlagMode(flag, env);
  if (mode === "on") return true;
  return stage4AllowlistMode(flag, env) && isStage4TestViewer(viewer, env);
}

/**
 * The gate of a ROUTE. `servedForAll` is the route's own existing check (flag exactly «on»): when it passes, NOTHING changes (the viewer is not even looked at here, so the «on» and off behaviours are exactly what they were).
 * Otherwise, only when one of `flags` is «allowlist», the viewer is resolved and checked against the allowlist; every other case is closed. Returns false for «not served»: the route answers its ordinary 404.
 */
export async function stage4RouteOpen(req: NextRequest, flags: readonly Stage4Flag[], servedForAll: () => boolean, env?: Env): Promise<boolean> {
  if (servedForAll()) return true;
  const e = env ?? processEnv();
  if (!flags.some((f) => stage4AllowlistMode(f, e))) return false;
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return false;
  return flags.some((f) => stage4ServedTo(f, auth.viewer, e));
}
