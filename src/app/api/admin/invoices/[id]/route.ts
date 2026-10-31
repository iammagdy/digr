import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { getSettings, loadDocument, saveDraft } from "@/lib/server/invoices/service";
import { badRequest, invoiceDb, invoiceErrorResponse, isUuid, notFound, pricingOf, readBody } from "@/lib/server/invoices/http";
import { documentInputSchema, parseInput } from "@/lib/invoices/validate";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Admin only. One document with its batches, lines and status log (and the seller text for the sheet). */
export async function GET(req: NextRequest, { params }: Ctx) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    if (!isUuid(id)) return notFound();
    const db = invoiceDb();
    const loaded = await loadDocument(db, id);
    if (!loaded) return notFound();
    return NextResponse.json({ ...loaded, seller: (await getSettings(db)).seller });
  } catch (e) { return invoiceErrorResponse(e); }
}

/** Admin only. Saves a DRAFT as a whole (the database refuses it once the document is locked or the screen is stale). */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    if (!isUuid(id)) return notFound();
    const parsed = parseInput(documentInputSchema, await readBody(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const revision = await saveDraft(invoiceDb(), auth.ctx.adminId, id, parsed.value, await pricingOf(auth.ctx));
    await auth.ctx.audit("invoice", "حفظ مسودة", id, { targetType: "invoice_documents", targetId: id });
    return NextResponse.json({ revision });
  } catch (e) { return invoiceErrorResponse(e); }
}
