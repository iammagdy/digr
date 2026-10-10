import { NextRequest, NextResponse } from "next/server";
import { Client as ServerClient, TablesDB, Client as UserClient, Account, Query } from "node-appwrite";
import { z } from "zod";
import { normalizePersonaProfileFields } from "@/functions/shared/personaConfigs";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

const serverClient = new ServerClient()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const tables = new TablesDB(serverClient);

const OnboardingSchema = z.object({
  persona: z.enum(["student", "researcher", "statistician", "marketer", "other"]).optional(),
  purposes: z.array(z.string().max(100)).max(10).optional(),
  topic: z.string().max(256).optional(),
}).strict().refine((value) => value.persona !== undefined || value.purposes !== undefined || value.topic !== undefined);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const parseResult = OnboardingSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { success: false, error: "البيانات المدخلة غير صحيحة", details: parseResult.error.format() },
        { status: 400 }
      );
    }

    const { persona, purposes: submittedPurposes, topic: submittedTopic } = parseResult.data;

    // 1. Authenticate caller strictly via JWT or session
    const authHeader = req.headers.get("authorization");
    const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
    const sessionCookie =
      req.cookies.get(`a_session_${projectId}`)?.value ||
      req.cookies.get(`a_session_${projectId}_legacy`)?.value;

    if (!bearerJwt && !sessionCookie) {
      return NextResponse.json(
        { success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    const userClient = new UserClient().setEndpoint(endpoint).setProject(projectId);
    if (bearerJwt) userClient.setJWT(bearerJwt);
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

    // 2. Fetch User Profile
    const profileRes = await tables.listRows({
      databaseId: "digr",
      tableId: "profiles",
      queries: [Query.equal("userId", verifiedUserId), Query.limit(1)],
    });

    if (profileRes.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: "الملف الشخصي غير موجود." },
        { status: 404 }
      );
    }

    const profileDoc = profileRes.rows[0];
    const normalizedProfile = normalizePersonaProfileFields(parseResult.data, profileDoc as { persona?: unknown; purposes?: unknown; topic?: unknown });
    const purposes = normalizedProfile.purposes;
    const topic = normalizedProfile.topic;

    // 3. Update Profile with Onboarding Data
    const updateData: Record<string, unknown> = { onboardingCompleted: true };
    if (persona !== undefined) updateData.persona = normalizedProfile.persona;
    if (submittedPurposes !== undefined) updateData.purposes = JSON.stringify(purposes);
    if (submittedTopic !== undefined) updateData.topic = topic;
    const updated = await tables.updateRow({
      databaseId: "digr",
      tableId: "profiles",
      rowId: profileDoc.$id,
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      profile: {
        userId: verifiedUserId,
        displayName: (updated as any).displayName,
        persona: normalizedProfile.persona,
        purposes,
        topic: (updated as any).topic,
        onboardingCompleted: true,
      },
      messageAr: "تم حفظ تفضيلاتك بنجاح!",
    });
  } catch (err: any) {
    console.error("Onboarding API error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "حدث خطأ غير متوقع." },
      { status: 500 }
    );
  }
}
