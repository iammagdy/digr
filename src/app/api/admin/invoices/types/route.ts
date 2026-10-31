import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createItemType, listItemTypes } from "@/lib/server/invoices/service";
import { badRequest, invoiceDb, invoiceErrorResponse, readBody } from "@/lib/server/invoices/http";
import { itemTypeInputSchema, parseInput } from "@/lib/invoices/validate";

export const dynamic = "force-dynamic";

/** Admin only. The item-type catalog (names and the owner's default SALE prices). */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try { return NextResponse.json({ types: await listItemTypes(invoiceDb()) }); } catch (e) { return invoiceErrorResponse(e); }
}

export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const parsed = parseInput(itemTypeInputSchema, await readBody(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const type = await createItemType(invoiceDb(), auth.ctx.adminId, parsed.value);
    await auth.ctx.audit("invoice", "إضافة نوع بند", type.id, { targetType: "invoice_item_types", targetId: type.id });
    return NextResponse.json({ type }, { status: 201 });
  } catch (e) { return invoiceErrorResponse(e); }
}
