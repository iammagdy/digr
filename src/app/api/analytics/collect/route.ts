import { after, NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateUser } from "@/lib/server/userAuth";
import { MAX_BEACON_BYTES, VISITOR_COOKIE, VISITOR_COOKIE_MAX_AGE_S, createRateLimiter, decideCollect, type VisitRow } from "@/lib/analytics/collect";

export const dynamic = "force-dynamic";

/** At most 40 beacons a minute per visitor session, and 3,000 a minute per server instance (a flood cannot fill the table). */
const limiters = {
  perVisitor: createRateLimiter({ max: 40, windowMs: 60_000 }),
  global: createRateLimiter({ max: 3_000, windowMs: 60_000 }),
};
const WRITE_TIMEOUT_MS = 2_500;
let warned = false;

/** One insert, never awaited by the visitor. A failing or slow write is dropped: a visit record is never worth a slow or broken page. */
async function store(row: VisitRow): Promise<void> {
  try {
    const write = createAdminClient().from("visitor_events").insert(row);
    const result: any = await Promise.race([write, new Promise((resolve) => setTimeout(() => resolve({ error: { message: "timeout" } }), WRITE_TIMEOUT_MS))]);
    if (result?.error && !warned) {
      warned = true;
      console.warn("[analytics:store_failed]", String(result.error.code || result.error.message || "").slice(0, 60));
    }
  } catch {
    // fail-open
  }
}

/**
 * The visit beacon: one call when a page is viewed and one when it is left (with the time spent). Public on purpose (no sign-in call per beacon: the
 * middleware lists it as a public path). It stores only what `lib/analytics/privacy` allows, answers 204 at once and writes after the answer.
 */
export async function POST(req: NextRequest) {
  const quiet = () => new NextResponse(null, { status: 204 });
  try {
    if (Number(req.headers.get("content-length") || 0) > MAX_BEACON_BYTES) return new NextResponse(null, { status: 413 });
    const text = (await req.text()).slice(0, MAX_BEACON_BYTES);
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { return new NextResponse(null, { status: 400 }); }

    // An account is looked up for «login» and «signup» only (rare), never for a page view.
    let verifiedUserId: string | null = null;
    let verifiedIsAdmin = false;
    const kind = String((body as any)?.k ?? "");
    if (kind === "login" || kind === "signup") {
      const auth = await authenticateUser(req);
      if (auth.ok) { verifiedUserId = auth.user.id; verifiedIsAdmin = auth.user.appRole === "admin"; }
    }

    const decision = decideCollect({
      body,
      headers: req.headers,
      cookieVisitorId: req.cookies.get(VISITOR_COOKIE)?.value ?? null,
      ownHost: req.headers.get("host"),
      verifiedUserId,
      verifiedIsAdmin,
    }, limiters);

    const res = decision.status === 204 ? quiet() : new NextResponse(null, { status: decision.status });
    if (decision.setVisitorId) {
      res.cookies.set(VISITOR_COOKIE, decision.setVisitorId, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: VISITOR_COOKIE_MAX_AGE_S });
    }
    if (decision.row) {
      const row = decision.row;
      try { after(() => store(row)); } catch { void store(row); }
    }
    return res;
  } catch {
    return quiet();
  }
}
