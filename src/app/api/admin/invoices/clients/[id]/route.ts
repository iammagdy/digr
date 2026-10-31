import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { updateClient } from "@/lib/server/invoices/service";
import { badRequest, invoiceDb, invoiceErrorResponse, isUuid, notFound, readBody } from "@/lib/server/invoices/http";
import { clientInputSchema, parseInput } from "@/lib/invoices/validate";

export const dynamic = "force-dynamic";

/** Admin only. Edits or archives a saved client. Documents already made keep their own copy of the client text. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    if (!isUuid(id)) return notFound();
    const parsed = parseInput(clientInputSchema, await readBody(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const client = await updateClient(invoiceDb(), auth.ctx.adminId, id, parsed.value);
    await auth.ctx.audit("invoice", "تعديل عميل", id, { targetType: "invoice_clients", targetId: id });
    return NextResponse.json({ client });
  } catch (e) { return invoiceErrorResponse(e); }
}
