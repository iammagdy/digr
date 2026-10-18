import { NextResponse } from "next/server";
import { loadSupportSettings } from "@/lib/server/supportSettings";

export const dynamic = "force-dynamic";

/** Public contact details (email and WhatsApp number); empty strings until the owner sets them. */
export async function GET() {
  return NextResponse.json(await loadSupportSettings());
}
