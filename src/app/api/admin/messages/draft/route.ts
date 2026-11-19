import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { DRAFT_ERRORS_AR, pickDraftRequest } from "@/lib/messageDraft";
import { callDraftModel, draftAuditDeps, runDraft } from "@/lib/server/messageDraft";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * «اكتب بالذكاء الاصطناعي» (DT-20261118-06 phase 2A). Admin only. Body: {note, tone, audience: "single" | "news_opt_in"}; EVERY other field is dropped before anything
 * else runs, so no customer name, address, id or balance can reach the model. Answers:
 * 200 {draft, refused: false, remaining} · 200 {draft, refused: true, fields, error, remaining} (the guard refused it twice: the admin fixes the highlighted fields)
 * · 400 / 429 / 502 / 503 / 504 {error, code}. Nothing is saved or sent here.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const input = pickDraftRequest(await req.json().catch(() => null));
    const outcome = await runDraft(
      { adminId: auth.ctx.adminId, note: input.note, tone: input.tone, audience: input.audience },
      { now: () => new Date(), callModel: callDraftModel, ...draftAuditDeps(createAdminClient() as unknown as { from: (table: string) => any }) },
    );
    if (!outcome.ok) return NextResponse.json({ error: outcome.message, code: outcome.code }, { status: outcome.status });
    if (outcome.refused) return NextResponse.json({ draft: outcome.draft, refused: true, fields: outcome.fields, error: outcome.message, remaining: outcome.remaining });
    return NextResponse.json({ draft: outcome.draft, refused: false, remaining: outcome.remaining });
  } catch {
    console.error("[admin-draft:exception]");
    return NextResponse.json({ error: DRAFT_ERRORS_AR.failed, code: "failed" }, { status: 502 });
  }
}
