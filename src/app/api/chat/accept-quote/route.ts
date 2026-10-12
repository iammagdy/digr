import { NextRequest, NextResponse } from "next/server";
import { Client as ServerClient, TablesDB, Storage, Client as UserClient, Account } from "node-appwrite";
import { acceptQuote } from "@/functions/shared/quoteAccept";
import { executeMultiStepJob } from "@/functions/shared/multiStepWorker";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

const serverClient = new ServerClient()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const tables = new TablesDB(serverClient);
const storage = new Storage(serverClient);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { quoteId, expectedPlanHash } = body;

    if (!quoteId || typeof quoteId !== "string") {
      return NextResponse.json(
        { success: false, error: "معرف عرض السعر مطلوب" },
        { status: 400 }
      );
    }

    // 1. Authenticate user strictly via JWT or session
    const authHeader = req.headers.get("authorization");
    const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
    const bodyJwt = typeof body.jwt === "string" ? body.jwt.trim() : null;
    const effectiveJwt = bearerJwt || bodyJwt;

    const sessionCookie =
      req.cookies.get(`a_session_${projectId}`)?.value ||
      req.cookies.get(`a_session_${projectId}_legacy`)?.value;

    if (!effectiveJwt && !sessionCookie) {
      return NextResponse.json(
        { success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    const userClient = new UserClient().setEndpoint(endpoint).setProject(projectId);
    if (effectiveJwt) userClient.setJWT(effectiveJwt);
    else if (sessionCookie) userClient.setSession(sessionCookie);

    let verifiedUserId: string;
    let emailVerified = false;
    try {
      const userAccount = new Account(userClient);
      const userDoc = await userAccount.get();
      verifiedUserId = userDoc.$id;
      emailVerified = userDoc.emailVerification === true;
    } catch {
      return NextResponse.json(
        { success: false, error: "انتهت صلاحية الجلسة. يرجى تسجيل الدخول مجدداً." },
        { status: 401 }
      );
    }

    if (!emailVerified) {
      return NextResponse.json({ success: false, error: "فعّل بريدك الإلكتروني أولًا لبدء البحث." }, { status: 403 });
    }

    // 2. Accept Quote & Reserve Credits atomically
    const acceptRes = await acceptQuote(tables, {
      userId: verifiedUserId,
      quoteId,
      expectedPlanHash,
    });

    if (!acceptRes.success || !acceptRes.jobId) {
      return NextResponse.json(
        { success: false, error: acceptRes.errorAr || "تعذر اعتماد العرض." },
        { status: acceptRes.statusCode || 400 }
      );
    }

    const jobId = acceptRes.jobId;

    // 3. Initiate job execution in background (or synchronous mock for offline/test)
    // Fetch job details for worker
    const jobDoc: any = await tables.getRow({ databaseId: "digr", tableId: "jobs", rowId: jobId });
    const quoteDoc: any = await tables.getRow({ databaseId: "digr", tableId: "plans_quotes", rowId: quoteId });

    let items = [];
    try {
      items = JSON.parse(quoteDoc.itemsJson || "[]");
    } catch {
      items = [];
    }

    // Trigger execution: in production via deployed job-worker Function, or fallback to in-process worker
    let triggeredFunction = false;
    try {
      const { Functions } = await import("node-appwrite");
      const fn = new Functions(serverClient);
      await fn.createExecution({
        functionId: "job-worker",
        body: JSON.stringify({ jobId }),
        async: true,
      });
      triggeredFunction = true;
    } catch (fnErr) {
      // Functions service unavailable or local testing: fallback to in-process multiStepWorker
    }

    if (!triggeredFunction) {
      executeMultiStepJob(tables, storage, {
        jobId,
        targetVolumeMax: quoteDoc.targetVolumeMax || 1,
        unitPricePoints: quoteDoc.unitPricePoints || 1,
        reservedCredits: quoteDoc.quotedPoints || 1,
        userId: verifiedUserId,
        templateSlug: jobDoc.templateSlug,
        params: typeof jobDoc.params === "string" ? JSON.parse(jobDoc.params) : jobDoc.params,
      }).catch((workerErr) => {
        console.error(`Worker error for job ${jobId}:`, workerErr);
      });
    }

    return NextResponse.json({
      success: true,
      jobId,
      quoteId,
      reservedCredits: acceptRes.reservedCredits,
      messageAr: "تم بدء استخراج البيانات بنجاح!",
    });
  } catch (err: any) {
    console.error("Accept quote error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "حدث خطأ غير متوقع." },
      { status: 500 }
    );
  }
}
