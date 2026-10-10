import { NextRequest, NextResponse } from "next/server";
import { Account, Client as ServerClient, Client as UserClient, TablesDB } from "node-appwrite";
import { saveCustomerComplaint } from "@/functions/shared/goodwillRefund";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;
const tables = new TablesDB(new ServerClient().setEndpoint(endpoint).setProject(projectId).setKey(apiKey));
const categories = new Set(["data_type", "period", "count", "quality", "other"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authHeader = req.headers.get("authorization");
  const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const sessionCookie = req.cookies.get(`a_session_${projectId}`)?.value || req.cookies.get(`a_session_${projectId}_legacy`)?.value;
  if (!bearerJwt && !sessionCookie) return NextResponse.json({ success: false, error: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
  const userClient = new UserClient().setEndpoint(endpoint).setProject(projectId);
  if (bearerJwt) userClient.setJWT(bearerJwt);
  else userClient.setSession(sessionCookie!);
  let userId: string;
  try { userId = (await new Account(userClient).get()).$id; }
  catch { return NextResponse.json({ success: false, error: "انتهت صلاحية الجلسة." }, { status: 401 }); }

  if (process.env.GOODWILL_ENABLED !== "true") return NextResponse.json({ success: false, error: "إرسال الملاحظات غير متاح حالياً." }, { status: 503 });
  const { id: jobId } = await params;
  if (!jobId || jobId.length > 36) return NextResponse.json({ success: false, error: "معرف الطلب غير صالح." }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  if (typeof body.category !== "string" || !categories.has(body.category)) {
    return NextResponse.json({ success: false, error: "اختَر نوع الملاحظة من القائمة." }, { status: 400 });
  }
  if (body.details !== undefined && (typeof body.details !== "string" || body.details.length > 1000)) {
    return NextResponse.json({ success: false, error: "الملاحظة أطول من الحد المسموح." }, { status: 400 });
  }

  try {
    const job: any = await tables.getRow({ databaseId: "digr", tableId: "jobs", rowId: jobId });
    if (job.userId !== userId) return NextResponse.json({ success: false, error: "غير مصرح بإرسال ملاحظة لهذا الطلب." }, { status: 403 });
    if (!["done", "cancelled"].includes(job.status)) return NextResponse.json({ success: false, error: "المراجعة متاحة بعد انتهاء الطلب فقط." }, { status: 409 });
    await saveCustomerComplaint(tables, { userId, jobId, category: body.category, details: body.details });
    return NextResponse.json({ success: true, message: "استلمنا ملاحظتك وهنراجعها." });
  } catch {
    return NextResponse.json({ success: false, error: "تعذر حفظ الملاحظة حالياً. جرّب مرة أخرى." }, { status: 503 });
  }
}
