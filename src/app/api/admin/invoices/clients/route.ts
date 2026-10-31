import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createClient, listClients } from "@/lib/server/invoices/service";
import { badRequest, invoiceDb, invoiceErrorResponse, readBody } from "@/lib/server/invoices/http";
import { clientInputSchema, parseInput } from "@/lib/invoices/validate";

export const dynamic = "force-dynamic";

/** Admin only. Saved clients. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try { return NextResponse.json({ clients: await listClients(invoiceDb()) }); } catch (e) { return invoiceErrorResponse(e); }
}

export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const parsed = parseInput(clientInputSchema, await readBody(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const client = await createClient(invoiceDb(), auth.ctx.adminId, parsed.value);
    await auth.ctx.audit("invoice", "إضافة عميل", client.id, { targetType: "invoice_clients", targetId: client.id });
    return NextResponse.json({ client }, { status: 201 });
  } catch (e) { return invoiceErrorResponse(e); }
}
