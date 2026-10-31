import { NextRequest, NextResponse } from "next/server";
import { AGENT_MAX_FILES, AGENT_MAX_FILE_BYTES } from "@/lib/invoices/chat/limits";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { callAnthropicBlocks } from "@/lib/server/invoices/assist";
import { AGENT_ERRORS_AR, agentAuditDeps, runAgent } from "@/lib/server/invoices/chat/run";
import { invoiceDb, invoiceErrorResponse } from "@/lib/server/invoices/http";
import { listItemTypes } from "@/lib/server/invoices/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (v: FormDataEntryValue | null): unknown => { try { return typeof v === "string" ? JSON.parse(v) : null; } catch { return null; } };

/**
 * Admin only (authenticateAdmin runs first). «مساعد الفواتير»: one chat turn. multipart/form-data: message, history (JSON), draft (JSON: names and counts, no prices), files[].
 * The files are read IN MEMORY by code and counted by code; the model sees only masked profiles (never a raw cell) and returns a mapping and a fixed list of actions.
 * Nothing is stored or logged from the files. 30 turns per admin per hour (counted in the audit table before the model is called), 4,000 characters, 5 files, 10 MB each.
 * The Anthropic key is resolved on the server and never leaves it. Nothing here saves a document, sends it, or changes its status.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    let fd: FormData;
    try { fd = await req.formData(); } catch { return NextResponse.json({ error: AGENT_ERRORS_AR.empty, code: "bad_request" }, { status: 400 }); }
    const picked = fd.getAll("files").filter((f): f is File => typeof f !== "string");
    if (picked.length > AGENT_MAX_FILES) return NextResponse.json({ error: AGENT_ERRORS_AR.tooManyFiles, code: "too_many_files" }, { status: 400 });
    for (const f of picked) if (f.size > AGENT_MAX_FILE_BYTES) return NextResponse.json({ error: `الملف «${f.name}» أكبر من ١٠ ميجابايت.`, code: "too_big" }, { status: 400 });
    const files = await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));

    const db = invoiceDb();
    const types = (await listItemTypes(db)).filter((t) => t.isActive).map((t) => t.nameAr);
    const message = fd.get("message");
    const outcome = await runAgent(
      { adminId: auth.ctx.adminId, message: typeof message === "string" ? message : "", history: json(fd.get("history")), draft: json(fd.get("draft")), files, itemTypeNames: types },
      { now: () => new Date(), callModel: (system, content, max) => callAnthropicBlocks(system, content as unknown as Array<Record<string, unknown>>, max), ...agentAuditDeps(db as unknown as { from: (table: string) => any }) },
    );
    if (!outcome.ok) return NextResponse.json({ error: outcome.message, code: outcome.code }, { status: outcome.status });
    return NextResponse.json(outcome);
  } catch (e) { return invoiceErrorResponse(e); }
}
