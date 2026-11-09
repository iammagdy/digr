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
import { checkUploadedAttachment, UPLOAD_MAX_BYTES } from "@/lib/server/mailAttachment";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const USER_ID = /^[A-Za-z0-9_-]{1,36}$/;
const MISSION_ID = /^msn_[a-z0-9]{8,40}$/;
const FILE_NAME = /^result\.(xlsx|csv)$/;
const KEY = /^[A-Za-z0-9_-]{8,80}$/;
const siteUrl = () => (process.env.APP_URL || "").trim() || undefined;

type MissionFile = { name: string; path: string; kind?: string };
interface Attachment { filename: string; content: Buffer; source: string }

/** Every outside call answers within its own time: the route always answers the admin with a clear sentence, before the platform's own limit cuts it off with no answer. */
class StepTimeout extends Error { constructor(public step: string) { super(`timeout:${step}`); } }
async function within<T>(step: string, ms: number, work: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StepTimeout(step)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
const STEP_AR: Record<string, string> = {
  account: "قراءة بيانات العميل", mission: "قراءة المهمة", file: "تحميل ملف المهمة", upload: "قراءة الملف المرفوع", send: "خدمة البريد",
};

/**
 * THE FILE OF A MISSION, attached to a customer's e-mail: only a mission of THIS customer, or of the admin's test account (a mission the admin ran
 * for them from «الوكيل»). A mission of another customer is refused, so one customer's data can never be mailed to another.
 */
async function attachmentOf(client: any, customerId: string, missionId: string, fileName: string): Promise<{ ok: true; value: Attachment } | { ok: false; status: number; errorAr: string }> {
  if (!MISSION_ID.test(missionId) || !FILE_NAME.test(fileName)) return { ok: false, status: 400, errorAr: "رقم المهمة أو اسم الملف غير صالح." };
  const { data: mission } = await within("mission", 10_000, client.from(MISSION_TABLE).select(`id,user_id,files,plan,request_text,delivered_units,updated_at,${ADDON_MARKER_COLUMN}`).eq("id", missionId).maybeSingle()) as { data: any };
  // an add-on row (a review or an edit of a delivered file) is not a mission of its own: its file is never mailed from here
  if (!mission || hasAddonMarker(mission)) return { ok: false, status: 404, errorAr: "المهمة غير موجودة." };
  const test = await within("mission", 10_000, findTestAccount(client));
  if (mission.user_id !== customerId && (!test || mission.user_id !== test.id)) return { ok: false, status: 403, errorAr: "هذه المهمة ليست لهذا العميل ولا لحساب الاختبار، فلا يمكن إرفاق ملفها." };
  const file = Array.isArray(mission.files) ? (mission.files as MissionFile[]).find((f) => f.name === fileName) : undefined;
  if (!file) return { ok: false, status: 404, errorAr: "لا يوجد ملف نتائج في هذه المهمة بعد (لم تكتمل أو لم يُسلَّم فيها شيء)." };
  const { data: blob, error } = await within("file", 20_000, client.storage.from(AGENT_BUCKET).download(`${missionId}/${file.path}`)) as { data: Blob | null; error: unknown };
  if (error || !blob) return { ok: false, status: 500, errorAr: "تعذّر قراءة ملف المهمة." };
  const content = Buffer.from(await blob.arrayBuffer());
  if (content.length === 0) return { ok: false, status: 500, errorAr: "ملف المهمة فارغ." };
  if (content.length > CUSTOMER_MAIL_MAX_ATTACHMENT_BYTES) return { ok: false, status: 413, errorAr: "ملف المهمة أكبر من المسموح إرفاقه (١٠ ميجابايت)." };
  const filename = missionDownloadName({ files: mission.files, kind: file.kind ?? fileName.split(".").pop() ?? "", plan: mission.plan, requestText: mission.request_text, deliveredUnits: mission.delivered_units, date: mission.updated_at });
  return { ok: true, value: { filename, content, source: missionId } };
}

/** The customer (name, registered address) and their missions that have a file: what the composer offers to attach. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!USER_ID.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  try {
    const client = createAdminClient();
    const account = await within("account", 10_000, getAuthAccount(client, id));
    if (!account.email) return NextResponse.json({ error: "المستخدم غير موجود" }, { status: 404 });
    const { data } = await within("mission", 10_000, client.from(MISSION_TABLE).select(`id,status,request_text,files,created_at,${ADDON_MARKER_COLUMN}`).eq("user_id", id).order("created_at", { ascending: false }).limit(20)) as { data: any[] | null };
    const missions = withoutAddonRows(Array.isArray(data) ? data : []).map((m: any) => ({
      id: String(m.id), status: String(m.status ?? ""), createdAt: m.created_at ?? null, requestAr: String(m.request_text ?? "").slice(0, 140),
      files: (Array.isArray(m.files) ? (m.files as MissionFile[]) : []).map((f) => f.name).filter((n) => FILE_NAME.test(n)),
    }));
    return NextResponse.json({ email: account.email, name: account.name, greetingName: customerGreetingName(account.name), adminEmail: auth.ctx.adminEmail || null, uploadMaxBytes: UPLOAD_MAX_BYTES, missions });
  } catch (e) {
    return failure(e, "load");
  }
}

function failure(e: unknown, where: string): NextResponse {
  if (e instanceof StepTimeout) {
    console.error(`[admin-mail:timeout] where=${where} step=${e.step}`);
    return NextResponse.json({ error: `تأخرت ${STEP_AR[e.step] ?? "خطوة"} عن الرد؛ لم يُرسل شيء. حاول مرة أخرى.` }, { status: 504 });
  }
  console.error(`[admin-mail:exception] where=${where} name=${(e as Error)?.name ?? "unknown"}`);
  return NextResponse.json({ error: "حدث خطأ غير متوقع في الخادم؛ لم يُرسل شيء. حاول مرة أخرى." }, { status: 500 });
}

/**
 * JSON, or multipart (`payload` = the JSON below, `file` = a file from the admin's computer):
 * {action: "preview" | "send" | "test", subject, badge?, heading, body, ctaLabel?, ctaPath?, missionId?, fileName?, idempotencyKey}
 * preview: the recipient and the attachments' names and sizes (nothing is sent).
 * send: to the customer's REGISTERED address only (there is no free recipient field), from noreply@diger.tech with replies to support@diger.tech; audited.
 * test: the same e-mail to the ADMIN'S OWN address, to see it in a real inbox before the customer does.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // ONE LINE IN, ONE LINE OUT for every send (no address, no text): a failure the admin sees can then be told apart from one that never reached this route
  const started = Date.now();
  const multipart = (req.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data");
  console.info(`[admin-mail:in] multipart=${multipart ? 1 : 0} bytes=${req.headers.get("content-length") ?? "?"}`);
  const res = await handlePost(req, ctx);
  console.info(`[admin-mail:out] status=${res.status} ms=${Date.now() - started}`);
  return res;
}

async function handlePost(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!USER_ID.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  try {
    let body: any = {};
    let upload: File | null = null;
    const multipart = (req.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data");
    try {
      if (multipart) {
        const form = await within("upload", 20_000, req.formData());
        body = JSON.parse(String(form.get("payload") ?? "{}"));
        const f = form.get("file");
        upload = f && typeof f === "object" && "arrayBuffer" in f ? (f as File) : null;
      } else {
        body = await req.json();
      }
    } catch (e) {
      if (e instanceof StepTimeout) throw e;
      return NextResponse.json({ error: "طلب غير صالح (تعذّرت قراءة البيانات أو الملف؛ الحد الأقصى للملف ٤ ميجابايت)." }, { status: 400 });
    }
    const action = body?.action === "send" ? "send" : body?.action === "test" ? "test" : body?.action === "preview" ? "preview" : null;
    if (!action) return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });

    const checked = validateCustomerMessage(body);
    if (!checked.ok) return NextResponse.json({ error: checked.errorAr }, { status: 400 });
    const message = checked.value;

    const client = createAdminClient();
    const account = await within("account", 10_000, getAuthAccount(client, id));
    if (!account.email) return NextResponse.json({ error: "المستخدم غير موجود أو بلا بريد مسجّل" }, { status: 404 });

    const attachments: Attachment[] = [];
    const missionId = typeof body.missionId === "string" ? body.missionId.trim() : "";
    if (missionId) {
      const a = await attachmentOf(client, id, missionId, typeof body.fileName === "string" && body.fileName ? body.fileName : "result.xlsx");
      if (!a.ok) return NextResponse.json({ error: a.errorAr }, { status: a.status });
      attachments.push(a.value);
    }
    if (upload) {
      const bytes = Buffer.from(await within("upload", 20_000, upload.arrayBuffer()));
      const u = checkUploadedAttachment(upload.name, bytes);
      if (!u.ok) return NextResponse.json({ error: u.errorAr }, { status: 400 });
      attachments.push({ filename: u.filename, content: bytes, source: "upload" });
    }
    const total = attachments.reduce((n, a) => n + a.content.length, 0);
    if (total > CUSTOMER_MAIL_MAX_ATTACHMENT_BYTES) return NextResponse.json({ error: "المرفقات معًا أكبر من المسموح (١٠ ميجابايت)." }, { status: 413 });
    const attachmentInfo = attachments.map((a) => ({ filename: a.filename, bytes: a.content.length, source: a.source }));

    if (action === "preview") return NextResponse.json({ ok: true, to: account.email, subject: message.subject, attachments: attachmentInfo });

    const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!KEY.test(key)) return NextResponse.json({ error: "طلب غير صالح (مفتاح الإرسال)." }, { status: 400 });
    const to = action === "test" ? (auth.ctx.adminEmail || "") : account.email;
    if (!to) return NextResponse.json({ error: "لا يوجد بريد مسجّل لحسابك لإرسال النسخة التجريبية إليه." }, { status: 400 });
    const html = renderCustomerMessageHtml(message, { siteUrl: siteUrl() });
    const sent = await within("send", 25_000, sendCustomerMail({
      to, subject: action === "test" ? `[نسخة تجريبية] ${message.subject}` : message.subject, html, text: renderCustomerMessageText(message, { siteUrl: siteUrl() }),
      // a test and the real send never share a key: the real send after a test is a new e-mail
      idempotencyKey: `${action}:${id}:${key}`,
      ...(attachments.length > 0 ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })) } : {}),
    }));
    if (!sent.ok) return NextResponse.json({ error: customerMailFailureAr(sent.reason) }, { status: sent.reason === "no_key" ? 503 : 502 });
    if (action === "send") {
      try {
        await within("account", 8_000, auth.ctx.audit("email", "رسالة بريد إلى عميل", `${message.subject}${attachments.length ? ` · مرفقات: ${attachments.map((a) => a.source === "upload" ? a.filename : a.source).join("، ")}` : ""}`, { targetType: "user", targetId: id }));
      } catch { /* the e-mail went out; a lost audit row never turns it into a failure */ }
    }
    return NextResponse.json({ ok: true, to, attachments: attachmentInfo, messageAr: action === "test" ? `أُرسلت نسخة تجريبية إلى بريدك (${to}).` : `أُرسلت الرسالة إلى ${to}.` });
  } catch (e) {
    return failure(e, "post");
  }
}
