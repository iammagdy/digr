import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "../../../../lib/supabase/server";
import { verifyCronSecret } from "../../../../lib/server/cronAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby maximum

export async function GET(req: NextRequest) {
  // 1. Authenticate with CRON_SECRET (timing-safe)
  if (!verifyCronSecret(req)) {
    return NextResponse.json(
      { success: false, error: "غير مصرح. رمز الأمان الخاص بالمراقب اليومي غير صالح." },
      { status: 401 }
    );
  }

  const adminClient = createAdminClient();
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  try {
    // 2. Query stale jobs (> 30 minutes in queued or running without lease progress)
    const { data: staleJobs, error: queryErr } = await adminClient
      .from("jobs")
      .select("id, user_id, status, step, lease_until, updated_at")
      .in("status", ["queued", "running"])
      .or(`lease_until.lt.${thirtyMinutesAgo},and(lease_until.is.null,updated_at.lt.${thirtyMinutesAgo})`);

    if (queryErr) {
      return NextResponse.json(
        { success: false, error: queryErr.message },
        { status: 500 }
      );
    }

    const releasedJobs: any[] = [];

    // 3. Atomically release each abandoned job (force = true, release-first, zero debit)
    for (const job of staleJobs || []) {
      const { data: releaseData, error: relErr } = await adminClient.rpc("release_job_atomic", {
        p_job_id: job.id,
        p_error_message: "تم إلغاء المهمة تلقائياً بواسطة مراقب المهام (Watchdog) لتجاوز المهلة الزمنية، واسترجاع كامل الرصيد المحجوز.",
        p_force: true,
      });

      if (!relErr && releaseData?.success) {
        releasedJobs.push({
          jobId: job.id,
          userId: job.user_id,
          releasedCredits: releaseData.released_credits,
          alreadyReleased: releaseData.already_released,
        });

        // Notify user if newly released
        if (job.user_id && !releaseData.already_released) {
          try {
            const notifRes = await adminClient.from("notifications").insert({
              id: `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              user_id: job.user_id,
              title: "إلغاء واسترجاع طلب متوقف",
              body: "تم إلغاء المهمة تلقائياً لعدم الاستجابة لأكثر من 30 دقيقة، واسترجاع كامل الرصيد المحجوز إلى محفظتك دون أي خصم.",
              link: "/dashboard/jobs",
              read: false,
              created_at: new Date().toISOString(),
            });
            if (notifRes?.error) {
              console.error(
                `[watchdog:notification_insert_failed] reason=db_error code=${
                  notifRes.error.code || "unknown"
                }`
              );
            }
          } catch (notifErr: any) {
            console.error(
              `[watchdog:notification_insert_failed] reason=exception code=${
                notifErr?.code || "unknown"
              }`
            );
          }
        }
      } else {
        console.error(`Watchdog failed to release job ${job.id}:`, relErr);
      }
    }

    // 4. Daily purge of accounts past 30-day grace period
    // Non-financial rows only; credit_ledger, jobs, topups, job_events, plans_quotes, provider_costs survive for legal audit trail.
    // Rather than deleting profiles/auth.users (which fails on ON DELETE RESTRICT), ANONYMIZE profile and BAN auth user.
    let purgedAccountsCount = 0;
    try {
      const nowIso = new Date().toISOString();
      const { data: expiredProfiles, error: fetchExpiredErr } = await adminClient
        .from("profiles")
        .select("id")
        .not("deletion_scheduled_for", "is", null)
        .lte("deletion_scheduled_for", nowIso)
        .limit(10);

      if (fetchExpiredErr) {
        console.error("Watchdog failed to query expired profiles:", fetchExpiredErr);
      }

      for (const prof of expiredProfiles || []) {
        const uId = prof.id;
        try {
          // A. Delete non-financial database records
          await adminClient.from("messages").delete().eq("user_id", uId);
          await adminClient.from("notes").delete().eq("user_id", uId);
          await adminClient.from("conversations").delete().eq("user_id", uId);
          await adminClient.from("notifications").delete().eq("user_id", uId);
          await adminClient.from("artifact_versions").delete().eq("user_id", uId);
          await adminClient.from("capability_requests").delete().eq("user_id", uId);
          // B. Delete user's results-bucket storage files (keep receipts intact for financial audit)
          try {
            const { data: userFiles } = await adminClient.storage.from("results").list(uId);
            if (userFiles && userFiles.length > 0) {
              const filePaths = userFiles.map((f: any) => `${uId}/${f.name}`);
              await adminClient.storage.from("results").remove(filePaths);
            }
          } catch (storageErr) {
            console.error(`Failed to clean up results storage for ${uId}:`, storageErr);
          }

          // C. Anonymize profile (never hard delete profiles to satisfy foreign keys)
          await adminClient.from("profiles").update({
            email: `deleted_${uId}@purged.local`,
            sender_name: "مستخدم محذوف",
            sender_phone: null,
            deletion_scheduled_for: null,
            updated_at: new Date().toISOString(),
          }).eq("id", uId);

          // C. Disable / Ban auth user permanently (never delete auth.users to preserve financial FKs)
          try {
            await adminClient.auth.admin.updateUserById(uId, {
              ban_duration: "876600h", // Permanent ban (~100 years)
              email: `deleted_${uId}@purged.local`,
              email_confirm: false,
              user_metadata: {
                banned: true,
                purged: true,
                name: "مستخدم محذوف",
              },
            });
            await adminClient.auth.admin.signOut(uId, "global");
          } catch (authBanErr) {
            console.error(`Failed to ban purged auth user ${uId}:`, authBanErr);
          }

          purgedAccountsCount++;
        } catch (singlePurgeErr) {
          console.error(`Failed to purge non-financial data for ${uId}:`, singlePurgeErr);
        }
      }
    } catch (purgeErr) {
      console.error("Watchdog purge step error:", purgeErr);
    }

    return NextResponse.json({
      success: true,
      scannedAt: new Date().toISOString(),
      staleCount: staleJobs?.length || 0,
      releasedCount: releasedJobs.length,
      releasedJobs,
      purgedAccountsCount,
    });
  } catch (err: any) {
    console.error("Watchdog execution failed:", err);
    return NextResponse.json(
      { success: false, error: err.message || "حدث خطأ أثناء تشغيل مراقب المهام." },
      { status: 500 }
    );
  }
}
