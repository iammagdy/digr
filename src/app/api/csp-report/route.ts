import { NextRequest, NextResponse } from "next/server";
import { summarizeCspReport } from "@/lib/contentSecurityPolicy";

export const dynamic = "force-dynamic";

/** Receives report-only Content-Security-Policy violations. Always 204; logs one short, non-secret line. */
export async function POST(req: NextRequest) {
  try {
    const text = await req.text();
    if (text.length <= 8192) {
      const summary = summarizeCspReport(JSON.parse(text));
      if (summary) console.warn(`[csp:report] directive=${summary.directive} blocked=${summary.blocked}`);
    }
  } catch {
    /* malformed reports are ignored */
  }
  return new NextResponse(null, { status: 204 });
}
