import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { normalizeSupportSettings } from "@/lib/supportContact";

export const dynamic = "force-dynamic";

/** Public contact details (email and WhatsApp number); empty strings until the owner sets them. */
export async function GET() {
  try {
    const { data } = await createAdminClient().from("settings_public").select("value").eq("key", "support").maybeSingle();
    return NextResponse.json(normalizeSupportSettings(data?.value));
  } catch {
    return NextResponse.json({ supportEmail: "", whatsappNumber: "" });
  }
}
