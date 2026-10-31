import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { setStatus } from "@/lib/server/invoices/service";
import { badRequest, invoiceDb, invoiceErrorResponse, isUuid, notFound, pricingOf, readBody } from "@/lib/server/invoices/http";
import { parseInput, statusInputSchema } from "@/lib/invoices/validate";

export const dynamic = "force-dynamic";

/**
 * Admin only. «مرسلة» (locks and freezes the numbers), «مدفوعة» (date and reference), «ملغية». Each change writes its status event with the admin id inside the
 * database. Marking paid records the payment on the document ONLY: it does not credit points and touches no wallet or ledger table.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    if (!isUuid(id)) return notFound();
    const parsed = parseInput(statusInputSchema, await readBody(req));
    if (!parsed.ok) return badRequest(parsed.error);
    await setStatus(invoiceDb(), auth.ctx.adminId, id, parsed.value, await pricingOf(auth.ctx));
    await auth.ctx.audit("invoice", `تغيير حالة وثيقة إلى ${parsed.value.to}`, id, { targetType: "invoice_documents", targetId: id });
    return NextResponse.json({ ok: true });
  } catch (e) { return invoiceErrorResponse(e); }
}
