import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { calculateBalance } from "@/lib/supabase/ledger";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    let user = null;

    if (authHeader?.startsWith("Bearer ")) {
      const bearerJwt = authHeader.substring(7).trim();
      const { data, error } = await supabase.auth.getUser(bearerJwt);
      if (!error && data?.user) {
        user = data.user;
      }
    } else {
      const { data, error } = await supabase.auth.getUser();
      if (!error && data?.user) {
        user = data.user;
      }
    }

    if (!user) {
      return NextResponse.json({ success: false, error: "غير مصرح" }, { status: 401 });
    }

    const adminClient = createAdminClient();
    const balance = await calculateBalance(adminClient, user.id);

    return NextResponse.json({
      success: true,
      balance,
      userId: user.id,
    });
  } catch (err: any) {
    console.error("[api/wallet/balance] Error calculating balance:", err?.message || err);
    return NextResponse.json(
      { success: false, error: "تعذر احتساب الرصيد" },
      { status: 500 }
    );
  }
}
