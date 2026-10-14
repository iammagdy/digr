import { NextRequest, NextResponse } from "next/server";
import { runSmokeTests } from "../../../../functions/shared/smokeTest";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ auth_ok: false, error: "غير مصرح" }, { status: auth.response.status });
  }

  const summary = await runSmokeTests(auth.ctx.adminId);
  return NextResponse.json(summary);
}

export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) {
    return NextResponse.json({ auth_ok: false, error: "غير مصرح" }, { status: auth.response.status });
  }

  const summary = await runSmokeTests(auth.ctx.adminId);
  return NextResponse.json(summary);
}
