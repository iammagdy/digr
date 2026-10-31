import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { duplicateDocument } from "@/lib/server/invoices/service";
import { invoiceDb, invoiceErrorResponse, isUuid, notFound, pricingOf } from "@/lib/server/invoices/http";

export const dynamic = "force-dynamic";

/** Admin only. A copy as a new DRAFT (the correction path after «ملغية»). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    if (!isUuid(id)) return notFound();
    const newId = await duplicateDocument(invoiceDb(), auth.ctx.adminId, id, await pricingOf(auth.ctx));
    await auth.ctx.audit("invoice", "نسخ وثيقة", newId, { targetType: "invoice_documents", targetId: newId });
    return NextResponse.json({ id: newId }, { status: 201 });
  } catch (e) { return invoiceErrorResponse(e); }
}
