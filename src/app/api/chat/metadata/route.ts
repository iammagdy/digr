import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { getEnabledCapabilities } from "@/functions/shared/capabilityRegistry";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    let user = null;

    if (authHeader?.startsWith("Bearer ")) {
      const bearerJwt = authHeader.substring(7).trim();
      const { data } = await supabase.auth.getUser(bearerJwt);
      user = data?.user;
    } else {
      const { data } = await supabase.auth.getUser();
      user = data?.user;
    }

    if (!user) {
      return NextResponse.json({ success: false, error: "غير مصرح" }, { status: 401 });
    }

    const adminClient = createAdminClient();
    const capabilities = await getEnabledCapabilities(adminClient);

    return NextResponse.json({
      success: true,
      enabledCapabilitySlugs: capabilities.map((capability) => capability.slug),
    });
  } catch {
    console.info("chat_metadata_capabilities_unavailable");
    return NextResponse.json({ success: false, reasonCode: "capabilities_unavailable" }, { status: 503 });
  }
}
