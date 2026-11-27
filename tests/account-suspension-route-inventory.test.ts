import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DT-20261118-06 phase 1C, Gate 1 P1-1: no customer route that changes something can forget the suspension. Every route.ts outside the admin, cron and internal areas that exports
 * POST / PUT / PATCH / DELETE either checks the ban itself (isAccountSuspended), signs the customer in through a helper that checks it (authenticateUser, resolveMissionViewer),
 * or is named here with the reason it stays open. A new mutating route fails this test until it does one of the three.
 */
const ALLOWED_OPEN: Record<string, string> = {
  "src/app/api/chat/[retiredQuoteAction]/route.ts": "D-0248 cached chat tabs receive only a retirement error or not found; no account lookup or mutation",
  "src/app/api/jobs/[id]/nudge/route.ts": "only releases a stuck hold of an old request back to the customer (release_job_atomic): it gives points back, never spends",
  "src/app/api/support/messages/route.ts": "the suspension sentence tells the customer to contact support: support must stay reachable",
  "src/app/api/onboarding/route.ts": "the customer's own profile answers; starts nothing and spends nothing",
  "src/app/api/account/delete/route.ts": "the customer's right to delete the account stays open",
  "src/app/api/account/delete/cancel/route.ts": "cancelling one's own deletion stays open",
  "src/app/api/csp-report/route.ts": "browser security reports: no account",
  "src/app/api/worker/chunk/route.ts": "the worker, signed by the cron secret: no customer",
};
const SKIP = /^src\/app\/api\/(admin|cron|internal)\//;
const MUTATING = /export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\s*=/;
// fix push (QA FAIL at 6af74613): a changing route uses suspensionBlock (fresh lookup, fails closed) or one of the two helpers (they ask fresh and fail closed for POST, PUT, PATCH and DELETE); the cached
// read answer (isAccountSuspended) alone is not a guard for an action that changes something
const GUARDED = /suspensionBlock\(|authenticateUser\(|resolveMissionViewer\(/;
/** The only routes that may ask the helper for the read answer on a changing request, and why. */
const READ_ANSWER_OK: Record<string, string> = {
  "src/app/api/analytics/collect/route.ts": "telemetry beacons: a login or signup beacon only reads who the visitor is; refusing it for a lookup outage would lose visits, and it changes no customer data and spends nothing",
};

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routes(p));
    else if (name === "route.ts") out.push(relative(process.cwd(), p).split("\\").join("/"));
  }
  return out;
}

describe("every customer route that changes something checks the suspension, or says why it does not", () => {
  const all = routes(join(process.cwd(), "src/app/api")).filter((f) => !SKIP.test(f) && MUTATING.test(readFileSync(f, "utf8")));
  it("finds the mutating customer routes", () => {
    expect(all.length).toBeGreaterThan(15);
  });
  it.each(all)("%s", (file) => {
    const guarded = GUARDED.test(readFileSync(file, "utf8"));
    if (!guarded) expect(ALLOWED_OPEN[file], `${file}: add the suspension check, or a named reason in ALLOWED_OPEN`).toBeTruthy();
  });
  it("no changing route asks the cached read answer (isAccountSuspended) alone, and none passes { sensitive: false } without a named reason", () => {
    for (const file of all) {
      const src = readFileSync(file, "utf8");
      if (/isAccountSuspended\(/.test(src)) expect(src, `${file}: a changing route needs suspensionBlock( beside the cached read answer`).toMatch(/suspensionBlock\(/);
      if (/sensitive:\s*false/.test(src)) expect(READ_ANSWER_OK[file], `${file}: name the reason in READ_ANSWER_OK`).toBeTruthy();
    }
    for (const file of Object.keys(READ_ANSWER_OK)) expect(readFileSync(file, "utf8"), file).toMatch(/sensitive:\s*false/);
  });
  it("the two shared helpers branch on the method of the request: a change asks fresh and fails closed", () => {
    for (const file of ["src/lib/server/userAuth.ts", "src/lib/server/missionViewer.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toMatch(/isSensitiveMethod\(/);
      expect(src, file).toMatch(/await suspensionBlock\(/);
    }
  });
  it("the allow-list names only routes that exist and are not guarded (no stale entry)", () => {
    for (const file of Object.keys(ALLOWED_OPEN)) {
      expect(all, file).toContain(file);
      expect(GUARDED.test(readFileSync(file, "utf8")), file).toBe(false);
    }
  });
});
