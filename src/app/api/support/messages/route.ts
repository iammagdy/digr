import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createServerSideClient } from "@/lib/supabase/server";
import { jobReportMessageAr, normalizeSupportSettings, validateSupportMessage } from "@/lib/supportContact";
import { sendSupportMail } from "@/lib/server/supportMail";
import { getAuthAccount } from "@/lib/server/authAccount";

export const dynamic = "force-dynamic";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function tooMany(key: string, now = Date.now()): boolean {
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > MAX_PER_WINDOW;
}

function missingTable(error: any): boolean {
  return /42P01|PGRST205|does not exist|schema cache|could not find/i.test(`${error?.code || ""} ${error?.message || ""}`);
}

async function currentUser(req: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const header = req.headers.get("authorization");
    const result = header?.startsWith("Bearer ") ? await supabase.auth.getUser(header.substring(7).trim()) : await supabase.auth.getUser();
    return result.data?.user ?? null;
  } catch {
    return null;
  }
}

const SENT_AR = "وصلتنا رسالتك. سنرد عليك على بريدك الإلكتروني في أقرب وقت.";
const REPORTED_AR = "وصلنا بلاغك عن هذا الطلب، وسنراجعه ونتواصل معك.";
const FAILED_AR = "تعذر إرسال الرسالة الآن. حاول مرة أخرى بعد قليل، أو تواصل معنا عبر واتساب.";

/** Contact form and the automatic «بلّغ عن مشكلة» report. The message is stored first; the email is best effort. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown").split(",")[0].trim();
  // A hidden field real people never fill: bots that do are told it worked and nothing is stored.
  if (typeof body?.website === "string" && body.website.trim()) return NextResponse.json({ success: true, messageAr: SENT_AR });
  if (tooMany(ip)) return NextResponse.json({ success: false, messageAr: "رسائل كثيرة في وقت قصير. انتظر قليلًا ثم حاول مرة أخرى." }, { status: 429 });

  const user = await currentUser(req);
  const client = createAdminClient();
  const jobId = typeof body?.jobId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(body.jobId) ? body.jobId : null;

  let name: string, email: string, message: string, source: "contact" | "job_report" = "contact";
  if (jobId) {
    // A job report needs the owner of that job; name, email and wording come from the server.
    if (!user) return NextResponse.json({ success: false, messageAr: "سجّل الدخول أولًا لإرسال بلاغ عن طلبك." }, { status: 401 });
    const { data: job } = await client.from("jobs").select("id,user_id,status,delivered_units,target_volume_max").eq("id", jobId).maybeSingle();
    if (!job || job.user_id !== user.id) return NextResponse.json({ success: false, messageAr: "تعذر العثور على هذا الطلب في حسابك." }, { status: 404 });
    const account = await getAuthAccount(client, user.id);
    name = account.name || "عميل";
    email = account.email || user.email || "";
    message = jobReportMessageAr({ id: job.id, status: String(job.status), delivered: job.delivered_units, requested: job.target_volume_max });
    source = "job_report";
    const dup = await client.from("support_messages").select("id").eq("user_id", user.id).eq("job_id", jobId).limit(1);
    if (!dup.error && (dup.data || []).length > 0) return NextResponse.json({ success: true, messageAr: REPORTED_AR, duplicate: true });
  } else {
    const valid = validateSupportMessage(body);
    if (!valid.ok) return NextResponse.json({ success: false, messageAr: valid.errorAr }, { status: 400 });
    ({ name, email, message } = valid.value);
  }

  const id = randomUUID();
  const stored = await client.from("support_messages").insert({ id, user_id: user?.id ?? null, name, email, message, job_id: jobId, source });
  let storedOk = !stored.error;
  if (stored.error) {
    console.error(`[support:store_failed] reason=${missingTable(stored.error) ? "table_missing" : "insert_failed"}`);
  }

  let emailed = false;
  try {
    const { data } = await client.from("settings_public").select("value").eq("key", "support").maybeSingle();
    const support = normalizeSupportSettings(data?.value);
    if (support.supportEmail) {
      emailed = (await sendSupportMail({ id, to: support.supportEmail, replyTo: email, name, message, jobId })).ok;
    }
  } catch {
    emailed = false;
  }
  if (storedOk && emailed) {
    await client.from("support_messages").update({ emailed: true }).eq("id", id);
  }

  if (!storedOk && !emailed) return NextResponse.json({ success: false, messageAr: FAILED_AR }, { status: 503 });
  return NextResponse.json({ success: true, messageAr: source === "job_report" ? REPORTED_AR : SENT_AR });
}
