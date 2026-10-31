import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { updateItemType } from "@/lib/server/invoices/service";
import { badRequest, invoiceDb, invoiceErrorResponse, isUuid, notFound, readBody } from "@/lib/server/invoices/http";
import { itemTypeInputSchema, parseInput } from "@/lib/invoices/validate";

export const dynamic = "force-dynamic";

/** Admin only. Edits a type's name, default price, order or active flag (types are archived, never deleted). Issued documents are not affected: a line copies the price. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    if (!isUuid(id)) return notFound();
    const parsed = parseInput(itemTypeInputSchema, await readBody(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const type = await updateItemType(invoiceDb(), auth.ctx.adminId, id, parsed.value);
    await auth.ctx.audit("invoice", "تعديل نوع بند", id, { targetType: "invoice_item_types", targetId: id });
    return NextResponse.json({ type });
  } catch (e) { return invoiceErrorResponse(e); }
}
