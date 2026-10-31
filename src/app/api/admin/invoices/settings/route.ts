import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { getSettings, updateSeller } from "@/lib/server/invoices/service";
import { badRequest, invoiceDb, invoiceErrorResponse, pricingOf, readBody } from "@/lib/server/invoices/http";
import { defaultPaymentInstructions } from "@/lib/invoices/defaults";
import { parseInput, settingsInputSchema } from "@/lib/invoices/validate";

export const dynamic = "force-dynamic";

/** Admin only. The seller text, the last rate used, and the defaults a new document starts from (Instapay address and point value are READ from the pricing settings). */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const settings = await getSettings(invoiceDb());
    const pricing = await pricingOf(auth.ctx);
    return NextResponse.json({ ...settings, instapayAddress: pricing.instapayAddress, creditValueE4: pricing.creditValueE4, defaultPaymentInstructions: defaultPaymentInstructions(pricing.instapayAddress) });
  } catch (e) { return invoiceErrorResponse(e); }
}

export async function PUT(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const parsed = parseInput(settingsInputSchema, await readBody(req));
    if (!parsed.ok) return badRequest(parsed.error);
    await updateSeller(invoiceDb(), auth.ctx.adminId, parsed.value);
    await auth.ctx.audit("invoice", "تعديل بيانات البائع في الوثائق", "invoice_settings", { targetType: "invoice_settings", targetId: "invoice_settings" });
    return NextResponse.json({ ok: true });
  } catch (e) { return invoiceErrorResponse(e); }
}
