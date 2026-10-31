import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { auditDeps, callAnthropic, runAssist } from "@/lib/server/invoices/assist";
import { invoiceDb, invoiceErrorResponse, readBody } from "@/lib/server/invoices/http";
import { listItemTypes } from "@/lib/server/invoices/service";

export const dynamic = "force-dynamic";

/**
 * Admin only. «رتّبهالي»: reads the owner's note («سحبت ٢٠٠ شركة كهروميكانيكا ومعاهم ٣٤٠ مدير…») and returns sectors and counts as a DRAFT for the builder.
 * Limits: at most 2,000 characters, at most 20 calls per admin per hour (counted in the audit table, taken before the model is called).
 * The model sees the note and the item-type NAMES, returns only [{sector, item_type, quantity}], and never sees or sets a price or a total: nothing is saved here.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const body = (await readBody(req)) as { text?: unknown } | null;
    const db = invoiceDb();
    const types = (await listItemTypes(db)).filter((t) => t.isActive).map((t) => ({ id: t.id, nameAr: t.nameAr }));
    const outcome = await runAssist(
      { adminId: auth.ctx.adminId, text: typeof body?.text === "string" ? body.text : "", types },
      { now: () => new Date(), callModel: callAnthropic, ...auditDeps(db as unknown as { from: (table: string) => any }) },
    );
    if (!outcome.ok) return NextResponse.json({ error: outcome.message, code: outcome.code }, { status: outcome.status });
    return NextResponse.json({ sectors: outcome.sectors, cost: outcome.usage ? { model: outcome.usage.model, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens } : null });
  } catch (e) { return invoiceErrorResponse(e); }
}
