import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createDocument, listDocuments } from "@/lib/server/invoices/service";
import { badRequest, invoiceDb, invoiceErrorResponse, pricingOf, readBody } from "@/lib/server/invoices/http";
import { documentInputSchema, parseInput } from "@/lib/invoices/validate";

export const dynamic = "force-dynamic";

/** Admin only. The invoice list (filters: status, client, type, text) with the unpaid total. Reads the invoice tables only. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const p = req.nextUrl.searchParams;
    const result = await listDocuments(invoiceDb(), {
      status: p.get("status") || undefined, clientId: p.get("clientId") || undefined, docType: p.get("docType") || undefined, q: p.get("q") || undefined,
      limit: Number(p.get("limit") || 50), offset: Number(p.get("offset") || 0),
    });
    return NextResponse.json(result);
  } catch (e) { return invoiceErrorResponse(e); }
}

/** Admin only. Creates a DRAFT (the database assigns the number). Body: { docType, ...document }. */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const body = (await readBody(req)) as Record<string, unknown> | null;
    const docType = body?.docType;
    if (docType !== "quote" && docType !== "invoice" && docType !== "statement") return badRequest("نوع الوثيقة غير صالح.");
    const parsed = parseInput(documentInputSchema, body);
    if (!parsed.ok) return badRequest(parsed.error);
    const db = invoiceDb();
    const id = await createDocument(db, auth.ctx.adminId, docType, parsed.value, await pricingOf(auth.ctx));
    await auth.ctx.audit("invoice", "إنشاء مسودة", id, { targetType: "invoice_documents", targetId: id });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) { return invoiceErrorResponse(e); }
}
