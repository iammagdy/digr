import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { getAuthAccount } from "@/lib/server/authAccount";
import { AGENT_BUCKET, MISSION_TABLE } from "@/lib/agentMission/constants";
import { findTestAccount } from "@/lib/agentMission/adminActions";
import { ADDON_MARKER_COLUMN, hasAddonMarker, withoutAddonRows } from "@/lib/agentMission/addonMarker";
import { missionDownloadName } from "@/lib/agentMission/fileNames";
import { customerGreetingName, renderCustomerMessageHtml, renderCustomerMessageText, validateCustomerMessage } from "@/lib/customerMessage";
import { CUSTOMER_MAIL_MAX_ATTACHMENT_BYTES, customerMailFailureAr, sendCustomerMail } from "@/lib/server/customerMail";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const USER_ID = /^[A-Za-z0-9_-]{1,36}$/;
const MISSION_ID = /^msn_[a-z0-9]{8,40}$/;
const FILE_NAME = /^result\.(xlsx|csv)$/;
const KEY = /^[A-Za-z0-9_-]{8,80}$/;
const siteUrl = () => (process.env.APP_URL || "").trim() || undefined;

type MissionFile = { name: string; path: string; kind?: string };
interface Attachment { filename: string; content: Buffer; missionId: string; fileName: string }

/**
 * THE FILE OF A MISSION, attached to a customer's e-mail: only a mission of THIS customer, or of the admin's test account (a mission the admin ran
 * for them from «الوكيل»). A mission of another customer is refused, so one customer's data can never be mailed to another.
 */
async function attachmentOf(client: any, customerId: string, missionId: string, fileName: string): Promise<{ ok: true; value: Attachment } | { ok: false; status: number; errorAr: string }> {
  if (!MISSION_ID.test(missionId) || !FILE_NAME.test(fileName)) return { ok: false, status: 400, errorAr: "رقم المهمة أو اسم الملف غير صالح." };
  const { data: mission } = await client.from(MISSION_TABLE).select(`id,user_id,files,plan,request_text,delivered_units,updated_at,${ADDON_MARKER_COLUMN}`).eq("id", missionId).maybeSingle();
  // an add-on row (a review or an edit of a delivered file) is not a mission of its own: its file is never mailed from here
  if (!mission || hasAddonMarker(mission)) return { ok: false, status: 404, errorAr: "المهمة غير موجودة." };
  const test = await findTestAccount(client);
  if (mission.user_id !== customerId && (!test || mission.user_id !== test.id)) return { ok: false, status: 403, errorAr: "هذه المهمة ليست لهذا العميل ولا لحساب الاختبار، فلا يمكن إرفاق ملفها." };
  const file = Array.isArray(mission.files) ? (mission.files as MissionFile[]).find((f) => f.name === fileName) : undefined;
  if (!file) return { ok: false, status: 404, errorAr: "لا يوجد ملف بهذا الاسم في المهمة." };
  const { data: blob, error } = await client.storage.from(AGENT_BUCKET).download(`${missionId}/${file.path}`);
  if (error || !blob) return { ok: false, status: 500, errorAr: "تعذّر قراءة ملف المهمة." };
  const content = Buffer.from(await blob.arrayBuffer());
  if (content.length === 0) return { ok: false, status: 500, errorAr: "ملف المهمة فارغ." };
  if (content.length > CUSTOMER_MAIL_MAX_ATTACHMENT_BYTES) return { ok: false, status: 413, errorAr: "ملف المهمة أكبر من المسموح إرفاقه (١٠ ميجابايت)." };
  const filename = missionDownloadName({ files: mission.files, kind: file.kind ?? fileName.split(".").pop() ?? "", plan: mission.plan, requestText: mission.request_text, deliveredUnits: mission.delivered_units, date: mission.updated_at });
  return { ok: true, value: { filename, content, missionId, fileName } };
}

/** The customer (name, registered address) and their missions that have a file: what the composer offers to attach. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!USER_ID.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  const client = createAdminClient();
  const account = await getAuthAccount(client, id);
  if (!account.email) return NextResponse.json({ error: "المستخدم غير موجود" }, { status: 404 });
  const { data } = await client.from(MISSION_TABLE).select(`id,status,request_text,files,created_at,${ADDON_MARKER_COLUMN}`).eq("user_id", id).order("created_at", { ascending: false }).limit(20);
  const missions = withoutAddonRows(Array.isArray(data) ? data : []).map((m: any) => ({
    id: String(m.id), status: String(m.status ?? ""), createdAt: m.created_at ?? null, requestAr: String(m.request_text ?? "").slice(0, 140),
    files: (Array.isArray(m.files) ? (m.files as MissionFile[]) : []).map((f) => f.name).filter((n) => FILE_NAME.test(n)),
  }));
  return NextResponse.json({ email: account.email, name: account.name, greetingName: customerGreetingName(account.name), missions });
}

/**
 * {action: "preview" | "send", subject, badge?, heading, body, ctaLabel?, ctaPath?, missionId?, fileName?, idempotencyKey}
 * preview: the HTML that would go out, the recipient, and the attachment's name and size (nothing is sent).
 * send: sends it to the customer's REGISTERED address only (there is no free recipient field), from noreply@diger.tech with replies to
 * support@diger.tech, and writes an audit row with the subject and the attached mission.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!USER_ID.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  let body: any = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 }); }
  const action = body?.action === "send" ? "send" : body?.action === "preview" ? "preview" : null;
  if (!action) return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });

  const checked = validateCustomerMessage(body);
  if (!checked.ok) return NextResponse.json({ error: checked.errorAr }, { status: 400 });
  const message = checked.value;

  const client = createAdminClient();
  const account = await getAuthAccount(client, id);
  if (!account.email) return NextResponse.json({ error: "المستخدم غير موجود أو بلا بريد مسجّل" }, { status: 404 });

  let attachment: Attachment | null = null;
  const missionId = typeof body.missionId === "string" ? body.missionId.trim() : "";
  if (missionId) {
    const a = await attachmentOf(client, id, missionId, typeof body.fileName === "string" && body.fileName ? body.fileName : "result.xlsx");
    if (!a.ok) return NextResponse.json({ error: a.errorAr }, { status: a.status });
    attachment = a.value;
  }

  const html = renderCustomerMessageHtml(message, { siteUrl: siteUrl() });
  const attachmentInfo = attachment ? { filename: attachment.filename, bytes: attachment.content.length, missionId: attachment.missionId } : null;
  if (action === "preview") return NextResponse.json({ ok: true, to: account.email, subject: message.subject, html, attachment: attachmentInfo });

  const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  if (!KEY.test(key)) return NextResponse.json({ error: "طلب غير صالح (مفتاح الإرسال)." }, { status: 400 });
  const sent = await sendCustomerMail({
    to: account.email, subject: message.subject, html, text: renderCustomerMessageText(message, { siteUrl: siteUrl() }), idempotencyKey: `${id}:${key}`,
    ...(attachment ? { attachments: [{ filename: attachment.filename, content: attachment.content }] } : {}),
  });
  if (!sent.ok) return NextResponse.json({ error: customerMailFailureAr(sent.reason) }, { status: sent.reason === "no_key" ? 503 : 502 });
  await auth.ctx.audit("email", "رسالة بريد إلى عميل", `${message.subject}${attachment ? ` · مرفق ${attachment.missionId}` : ""}`, { targetType: "user", targetId: id });
  return NextResponse.json({ ok: true, to: account.email, attachment: attachmentInfo, messageAr: `أُرسلت الرسالة إلى ${account.email}.` });
}
