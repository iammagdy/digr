import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { renderCustomerMessageHtml, renderCustomerMessageText, validateCustomerMessage } from "@/lib/customerMessage";
import { CUSTOMER_TEXT_REFUSED_AR, customerTextIssues, messageContentHash, withCustomerName } from "@/lib/campaignText";
import { customerMailFailureAr, sendCustomerMail } from "@/lib/server/customerMail";
import { getCampaign, markTestSent, messageOf } from "@/lib/server/campaignStore";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const siteUrl = () => (process.env.APP_URL || "").trim() || undefined;

/**
 * «أرسل نسخة تجريبية لي» for a campaign (DT-20261118-06 phase 2B, Tier A). The ONLY address this route ever sends to is the signed-in admin's own: there is no recipient field.
 * The text must pass the same checks a customer send will: the message limits and the customer-text guard. The test is recorded with the hash of this exact text.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  const to = auth.ctx.adminEmail || "";
  if (!to) return NextResponse.json({ error: "لا يوجد بريد مسجّل لحسابك لإرسال النسخة التجريبية إليه." }, { status: 400 });
  const db = createAdminClient();
  const found = await getCampaign(db, id);
  if (!found.ok) return NextResponse.json({ error: found.messageAr, notReady: found.code === "not_ready" }, { status: found.status });
  const checked = validateCustomerMessage(messageOf(found.row));
  if (!checked.ok) return NextResponse.json({ error: checked.errorAr }, { status: 400 });
  const issues = customerTextIssues(checked.value);
  if (issues.length > 0) return NextResponse.json({ error: CUSTOMER_TEXT_REFUSED_AR, fields: issues.map((i) => i.field) }, { status: 422 });
  const hash = messageContentHash(checked.value);
  const message = withCustomerName(checked.value, null);
  const sent = await sendCustomerMail({
    to, subject: `[نسخة تجريبية] ${message.subject}`, html: renderCustomerMessageHtml(message, { siteUrl: siteUrl() }), text: renderCustomerMessageText(message, { siteUrl: siteUrl() }),
    idempotencyKey: `campaign-test:${id}:${found.row.revision}:${hash}`,
  });
  if (!sent.ok) return NextResponse.json({ error: customerMailFailureAr(sent.reason) }, { status: sent.reason === "no_key" ? 503 : 502 });
  const marked = await markTestSent(db, { adminId: auth.ctx.adminId, id, revision: found.row.revision, hash });
  try { await auth.ctx.audit("email", "نسخة تجريبية لحملة", found.row.name, { targetType: "campaign", targetId: id }); } catch { /* the test went out; a lost audit row is not a failure */ }
  return NextResponse.json({ ok: true, to, hash, recorded: marked.ok, messageAr: `أُرسلت نسخة تجريبية إلى بريدك (${to}).` });
}
