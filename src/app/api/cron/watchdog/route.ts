import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "../../../../lib/supabase/server";
import { verifyCronSecret } from "../../../../lib/server/cronAuth";
import { insertJobNotice, jobStalledNotice } from "../../../../lib/server/jobNotices";
import { getRecipient, sendPlatformEmail } from "../../../../lib/server/sendPlatformEmail";
import { getBalance } from "../../../../lib/supabase/ledger";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby maximum

export async function GET(req: NextRequest) {
  // 1. Authenticate with CRON_SECRET (timing-safe)
  if (!verifyCronSecret(req)) {
    return NextResponse.json(
      { success: false, error: "غير مصرح. رمز الأمان الخاص بالمهام المجدولة غير صالح." },
      { status: 401 }
    );
  }

  const adminClient = createAdminClient();
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  try {
    // 2. Query stale jobs (> 30 minutes in queued or running without lease progress)
    // Or target a specific job ID if requested
    const targetJobId = req.nextUrl.searchParams.get("jobId");
    let staleJobs: any[] = [];

    if (targetJobId) {
      const { data: specificJob, error: specificErr } = await adminClient
        .from("jobs")
        .select("id, user_id, status, step, lease_until, updated_at")
        .eq("id", targetJobId)
        .in("status", ["queued", "running"])
        .maybeSingle();

      if (specificErr) {
        return NextResponse.json({ success: false, error: specificErr.message }, { status: 500 });
      }
      if (specificJob) {
        staleJobs = [specificJob];
      }
    } else {
      const { data, error: queryErr } = await adminClient
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
      staleJobs = data || [];
    }

    const releasedJobs: any[] = [];

    // 3. Atomically release each abandoned job (force = true, release-first, zero debit)
    for (const job of staleJobs || []) {
      const { data: releaseData, error: relErr } = await adminClient.rpc("release_job_atomic", {
        p_job_id: job.id,
        p_error_message: "تم إلغاء الطلب تلقائياً لتأخر التنفيذ وتم إرجاع كامل نقاطك المحجوزة لرصيدك.",
        p_force: true,
      });

      if (!relErr && releaseData?.success) {
        releasedJobs.push({
          jobId: job.id,
          userId: job.user_id,
          releasedCredits: releaseData.released_credits,
          alreadyReleased: releaseData.already_released,
        });

        // Notify user if newly released: in-app, and by e-mail (the refund e-mail, with the points returned)
        if (job.user_id && !releaseData.already_released) {
          const delivered = await insertJobNotice(adminClient, job.user_id, jobStalledNotice());
          if (!delivered) console.error("[watchdog:notification_insert_failed]");
          try {
            const releasedCredits = Number(releaseData.released_credits) || 0;
            const rcpt = releasedCredits > 0 ? await getRecipient(adminClient, job.user_id, "refund") : null;
            if (rcpt) {
              const balance = await getBalance(adminClient, job.user_id);
              await sendPlatformEmail("refund", rcpt.email, {
                Name: rcpt.name,
                Points: String(Math.round(releasedCredits)),
                JobTitle: "طلبك الذي توقف",
                Reason: "توقف تنفيذ الطلب عن التقدم قبل اكتماله",
                Balance: String(balance),
              }, `stalled-refund:${job.id}`);
            }
          } catch (emailErr) {
            console.error("[email:stalled_refund_failed]", emailErr);
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

    // 5. Automatic cleanup of old unmigrated guest users (> 7 days old)
    let cleanedGuestsCount = 0;
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      if (typeof adminClient.auth?.admin?.listUsers === "function") {
        const { data: guestList } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 50 });
        for (const u of guestList?.users || []) {
          if (
            u.user_metadata?.is_guest === true &&
            u.created_at &&
            new Date(u.created_at) < new Date(sevenDaysAgo)
          ) {
            try {
              await adminClient.auth.admin.deleteUser(u.id);
              cleanedGuestsCount++;
            } catch {}
          }
        }
      }
    } catch (guestPurgeErr) {
      console.warn("[watchdog:guest_purge_warning]", guestPurgeErr);
    }

    return NextResponse.json({
      success: true,
      scannedAt: new Date().toISOString(),
      staleCount: staleJobs?.length || 0,
      releasedCount: releasedJobs.length,
      releasedJobs,
      purgedAccountsCount,
      cleanedGuestsCount,
    });
  } catch (err: any) {
    console.error("Watchdog execution failed:", err);
    return NextResponse.json(
      { success: false, error: err.message || "حدث خطأ أثناء فحص المهام المعلقة." },
      { status: 500 }
    );
  }
}
