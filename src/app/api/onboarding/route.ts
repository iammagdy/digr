import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const OnboardingSchema = z.object({
  persona: z.enum(["student", "researcher", "statistician", "marketer", "other"]),
  purposes: z.array(z.string().max(100)).max(10),
  topic: z.string().max(256).optional().default(""),
});

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

    const { persona, purposes, topic } = parseResult.data;

    // 1. Authenticate caller strictly via Supabase JWT or session
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    let user = null;

    if (authHeader?.startsWith("Bearer ")) {
      const bearerJwt = authHeader.substring(7).trim();
      const { data } = await supabase.auth.getUser(bearerJwt);
      user = data?.user;
    } else {
      const { data } = await supabase.auth.getUser();
      user = data?.user;
    }

    if (!user) {
      return NextResponse.json(
        { success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    const adminClient = createAdminClient();

    // 2. Update user metadata in Supabase Auth
    const updatedMetadata = {
      ...(user.user_metadata || {}),
      persona,
      purposes,
      topic: topic || "",
      onboardingCompleted: true,
    };

    const { error: updateAuthErr } = await adminClient.auth.admin.updateUserById(user.id, {
      user_metadata: updatedMetadata,
    });

    if (updateAuthErr) {
      throw updateAuthErr;
    }

    // 3. Update profiles table if matching columns exist
    await adminClient
      .from("profiles")
      .update({
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    return NextResponse.json({
      success: true,
      profile: {
        userId: user.id,
        displayName: user.user_metadata?.name || user.email?.split("@")[0] || "",
        persona,
        purposes,
        topic: topic || "",
        onboardingCompleted: true,
      },
    });
  } catch (err: any) {
    console.error("Onboarding API error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "حدث خطأ غير متوقع." },
      { status: 500 }
    );
  }
}
