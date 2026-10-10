import { NextRequest, NextResponse } from "next/server";
import { Client as ServerClient, TablesDB, Client as UserClient, Account } from "node-appwrite";
import { z } from "zod";
import {
  EditPlanOperationSchema,
  applyPlanOperations,
  validatePlanAgainstSchemas,
  createAndSaveManagedQuote,
  parseStoredPlan,
  PlanState,
} from "@/functions/shared/planManager";
import { getEnabledCapabilities } from "@/functions/shared/capabilityRegistry";
import { calculateBalance } from "@/functions/shared/ledger";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

const serverClient = new ServerClient()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const tables = new TablesDB(serverClient);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { quoteId, operations } = body;

    if (!quoteId || !Array.isArray(operations) || operations.length === 0) {
      return NextResponse.json(
        { success: false, error: "معرف عرض السعر وعمليات التعديل مطلوبة" },
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
    try {
      const userAccount = new Account(userClient);
      const userDoc = await userAccount.get();
      verifiedUserId = userDoc.$id;
    } catch {
      return NextResponse.json(
        { success: false, error: "انتهت صلاحية الجلسة. يرجى تسجيل الدخول مجدداً." },
        { status: 401 }
      );
    }

    // 2. Validate operations with strict Zod schema
    const parsedOps = z.array(EditPlanOperationSchema).safeParse(operations);
    if (!parsedOps.success) {
      return NextResponse.json(
        { success: false, error: "عمليات تعديل الخطة غير مطابقة للمخطط الأمني المعتمد." },
        { status: 400 }
      );
    }

    // 3. Fetch existing quote
    const quoteDoc: any = await tables.getRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: quoteId,
    });

    if (quoteDoc.userId !== verifiedUserId) {
      return NextResponse.json(
        { success: false, error: "غير مصرح لك بتعديل هذا العرض." },
        { status: 403 }
      );
    }

    if (quoteDoc.status === "accepted") {
      return NextResponse.json(
        { success: false, error: "لا يمكن تعديل الخطة بعد بدء التنفيذ بالفعل." },
        { status: 400 }
      );
    }

    // 4. Construct current plan state and apply operations
    const storedPlan = parseStoredPlan(quoteDoc.itemsJson || "[]");
    const currentPlan: PlanState = {
      ...storedPlan,
      summaryAr: quoteDoc.summaryAr || storedPlan.summaryAr || "خطة استخراج بيانات",
    };

    const updatedPlan = applyPlanOperations(currentPlan, parsedOps.data);

    // 5. Validate updated plan against capability schemas
    const capabilities = await getEnabledCapabilities(tables);
    const valResult = validatePlanAgainstSchemas(updatedPlan.items, capabilities);
    if (!valResult.valid) {
      return NextResponse.json(
        { success: false, error: `خطأ في معاملات الخطة: ${valResult.errors.join(", ")}` },
        { status: 400 }
      );
    }

    // 6. Generate NEW quote (supersedes old quote and recalculates price)
    const userBalance = await calculateBalance(tables, verifiedUserId);
    const newQuote = await createAndSaveManagedQuote(tables, {
      conversationId: quoteDoc.conversationId,
      userId: verifiedUserId,
      plan: updatedPlan,
      userBalance,
      capabilities,
    });

    return NextResponse.json({
      success: true,
      quote: newQuote,
      messageAr: "تم تحديث الخطة وإعادة احتساب عرض السعر بنجاح!",
    });
  } catch (err: any) {
    console.error("Edit plan API error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "حدث خطأ أثناء تعديل الخطة." },
      { status: 500 }
    );
  }
}
