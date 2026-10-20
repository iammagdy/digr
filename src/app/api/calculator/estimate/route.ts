import { NextRequest, NextResponse } from "next/server";
import { estimateMission, estimateSummaryAr, parseEstimateText, type EstimateInput, type EstimateKind } from "@/lib/missionEstimate";
import { RATE_LIMITED_MESSAGE_AR, clientKey, createRateLimiter } from "@/lib/server/publicRateLimit";
import type { SocialPlatformId } from "@/lib/socialTasks";
import { liveDailyCapPoints } from "@/lib/server/liveDailyCap";

export const dynamic = "force-dynamic";

/** Public. Pure code: no model, no provider, no database. Rate-limited per visitor. */
const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });

const KINDS: readonly EstimateKind[] = ["comments", "posts", "videos", "companies", "people"];
const PLATFORMS: readonly SocialPlatformId[] = ["facebook", "youtube", "tiktok", "instagram", "x", "reddit", "linkedin"];

function positiveInt(value: unknown, max: number): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= max ? number : null;
}

export async function POST(req: NextRequest) {
  const decision = limiter.check(clientKey(req.headers));
  if (!decision.allowed) {
    return NextResponse.json({ success: false, error: RATE_LIMITED_MESSAGE_AR }, { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ success: false, error: "بيانات الطلب غير صالحة." }, { status: 400 });

  let input: EstimateInput | null = null;
  let understoodAr: string | null = null;
  let missingAr: string[] = [];
  if (typeof body.text === "string" && body.text.trim()) {
    const parsed = parseEstimateText(body.text);
    input = parsed.input;
    understoodAr = parsed.understoodAr;
    missingAr = parsed.missingAr;
  } else if (KINDS.includes(body.kind)) {
    input = {
      kind: body.kind,
      platform: PLATFORMS.includes(body.platform) ? body.platform : null,
      volume: positiveInt(body.volume, 1_000_000),
      budgetPoints: positiveInt(body.budgetPoints, 10_000_000),
      openEnded: body.openEnded === true,
    };
  } else {
    return NextResponse.json({ success: false, error: "اختر نوع البيانات أو اكتب طلبك." }, { status: 400 });
  }
  if (!input) return NextResponse.json({ success: true, result: null, understoodAr, missingAr });
  // The same live limit the detailed calculator and the segment pages use, so all three size one job alike.
  const result = estimateMission({ ...input, dailyCapPoints: await liveDailyCapPoints() });
  return NextResponse.json({
    success: true,
    result,
    summaryAr: result.status === "ok" ? estimateSummaryAr(result) : null,
    understoodAr,
    missingAr,
  });
}
