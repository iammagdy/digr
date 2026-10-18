import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { isValidEmail, normalizeSupportSettings, normalizeWhatsapp } from "@/lib/supportContact";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { data } = await createAdminClient().from("settings_public").select("value").eq("key", "support").maybeSingle();
  return NextResponse.json(normalizeSupportSettings(data?.value));
}

/** Saves the public support email and WhatsApp number (settings_public / support). Empty clears a value. */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => ({}));
  const email = String(body?.supportEmail ?? "").trim();
  const rawWhatsapp = String(body?.whatsappNumber ?? "").trim();
  const whatsapp = normalizeWhatsapp(rawWhatsapp);
  if (email && !isValidEmail(email)) return NextResponse.json({ error: "البريد الإلكتروني غير صالح" }, { status: 400 });
  if (rawWhatsapp && !whatsapp) return NextResponse.json({ error: "رقم واتساب غير صالح. اكتب الرقم بصيغة دولية، مثل ٢٠١٠٠٠٠٠٠٠٠٠٠" }, { status: 400 });
  const { error } = await createAdminClient().from("settings_public").upsert({
    key: "support",
    value: { supportEmail: email, whatsappNumber: whatsapp },
    updated_at: new Date().toISOString(),
  });
  if (error) return NextResponse.json({ error: "تعذّر حفظ بيانات الدعم" }, { status: 500 });
  await auth.ctx.audit("setting", "تغيير بيانات الدعم", "support", { targetType: "settings_public", targetId: "support" });
  return NextResponse.json({ success: true });
}
