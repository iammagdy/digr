import { Client, Users, TablesDB, Storage, Query } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const hasConfirm = process.argv.includes("--confirm");

if (!hasConfirm) {
  console.error("🛑 SAFETY GUARD ACTIVATED:");
  console.error("This script will only delete accounts ending strictly in '@digr.test' and their associated data.");
  console.error("Real accounts (including magdy.saber@outlook.com) and their data are strictly protected.");
  console.error("To proceed, you must explicitly pass the --confirm flag:");
  console.error("  npx tsx scripts/cleanup-all.ts --confirm\n");
  process.exit(1);
}

const c = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
  .setKey(process.env.APPWRITE_API_KEY!);

const u = new Users(c);
const t = new TablesDB(c);
const s = new Storage(c);

async function cleanSafe() {
  console.log("🛡️ Starting SAFE cleanup for test accounts ending strictly in '@digr.test'...\n");

  const userList = await u.list();
  const realUserIds = new Set<string>();

  for (const user of userList.users) {
    if (!user.email.toLowerCase().endsWith("@digr.test")) {
      realUserIds.add(user.$id);
      console.log(`  🔒 Protected Real User: ${user.$id} (${user.email})`);
    }
  }

  const testUsers = userList.users.filter((user) =>
    user.email.toLowerCase().endsWith("@digr.test")
  );

  console.log(`\nFound ${testUsers.length} test accounts (@digr.test) to clean.`);

  for (const testUser of testUsers) {
    const userId = testUser.$id;
    console.log(`\nCleaning data for test user: ${userId} (${testUser.email})...`);

    // 1. Delete associated jobs and their events
    try {
      const jobs = await t.listRows({
        databaseId: "digr",
        tableId: "jobs",
        queries: [Query.equal("userId", userId)],
      });
      for (const job of jobs.rows) {
        const events = await t.listRows({
          databaseId: "digr",
          tableId: "job_events",
          queries: [Query.equal("jobId", job.$id)],
        });
        for (const ev of events.rows) {
          await t.deleteRow({ databaseId: "digr", tableId: "job_events", rowId: ev.$id });
        }
        if ((job as any).resultFileId) {
          await s.deleteFile("results", (job as any).resultFileId).catch(() => {});
        }
        await t.deleteRow({ databaseId: "digr", tableId: "jobs", rowId: job.$id });
        console.log(`  ✓ Removed test job ${job.$id} and child events`);
      }
    } catch (e: any) {
      console.warn(`  ! Note on jobs cleanup: ${e.message}`);
    }

    // 2. Delete associated topups and receipts
    try {
      const topups = await t.listRows({
        databaseId: "digr",
        tableId: "topups",
        queries: [Query.equal("userId", userId)],
      });
      for (const top of topups.rows) {
        if ((top as any).receiptFileId) {
          await s.deleteFile("receipts", (top as any).receiptFileId).catch(() => {});
        }
        await t.deleteRow({ databaseId: "digr", tableId: "credit_ledger", rowId: `top_${top.$id}` }).catch(() => {});
        await t.deleteRow({ databaseId: "digr", tableId: "topups", rowId: top.$id });
        console.log(`  ✓ Removed test topup ${top.$id}`);
      }
    } catch (e: any) {
      console.warn(`  ! Note on topups cleanup: ${e.message}`);
    }

    // 3. Delete remaining ledger rows for user
    try {
      const ledger = await t.listRows({
        databaseId: "digr",
        tableId: "credit_ledger",
        queries: [Query.equal("userId", userId)],
      });
      for (const row of ledger.rows) {
        await t.deleteRow({ databaseId: "digr", tableId: "credit_ledger", rowId: row.$id });
      }
    } catch (e: any) {
      console.warn(`  ! Note on ledger cleanup: ${e.message}`);
    }

    // 4. Delete profile row
    await t.deleteRow({ databaseId: "digr", tableId: "profiles", rowId: userId }).catch(() => {});

    // 5. Delete test user account
    await u.delete(userId);
    console.log(`  ✓ Test user ${userId} (${testUser.email}) safely removed.`);
  }

  // 6. Check for orphaned profiles that do NOT belong to any real user
  try {
    const allProfiles = await t.listRows({ databaseId: "digr", tableId: "profiles" });
    for (const prof of allProfiles.rows) {
      if (!realUserIds.has(prof.$id)) {
        // Orphaned profile from deleted test user
        await t.deleteRow({ databaseId: "digr", tableId: "profiles", rowId: prof.$id });
        console.log(`  ✓ Removed orphaned test profile: ${prof.$id}`);
      }
    }
  } catch (e: any) {
    console.warn(`  ! Note on profiles check: ${e.message}`);
  }

  console.log("\n✅ Safe cleanup completed. No real users or real user data were touched.");
}

cleanSafe().catch(console.error);
