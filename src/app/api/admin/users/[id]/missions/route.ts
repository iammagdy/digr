import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { adminUserMission, readUserMissions } from "@/lib/server/adminUserMissions";

export const dynamic = "force-dynamic";

const USER_ID = /^[A-Za-z0-9_-]{1,36}$/;

/** The profile's «المهام» tab (DT-20261118-06 phase 1B): the newest 20 missions of this customer, add-on rows removed. Admin only, read only. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!USER_ID.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  const { rows, failed } = await readUserMissions(createAdminClient(), id);
  if (failed) return NextResponse.json({ error: "تعذّر قراءة المهام الآن." }, { status: 500 });
  return NextResponse.json({ missions: rows.map(adminUserMission) }, { headers: { "Cache-Control": "no-store" } });
}
