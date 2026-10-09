import { Client, Users, TablesDB, Storage } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const c = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
  .setKey(process.env.APPWRITE_API_KEY!);

const u = new Users(c);
const t = new TablesDB(c);
const s = new Storage(c);

async function clean() {
  console.log("🧹 Performing thorough cleanup of test entities...\n");

  // 1. Delete all test users
  const userList = await u.list();
  console.log(`Found ${userList.total} users.`);
  for (const user of userList.users) {
    if (user.email.endsWith("@digr.test") || user.email.includes("test")) {
      await u.delete(user.$id);
      console.log(`  ✓ Deleted test user: ${user.$id} (${user.email})`);
    }
  }

  // 2. Clean all dynamic tables
  const dynamicTables = [
    "profiles",
    "jobs",
    "job_events",
    "credit_ledger",
    "topups",
    "job_calls",
    "jobs_internal",
  ];

  for (const tableId of dynamicTables) {
    const rows = await t.listRows({ databaseId: "digr", tableId });
    if (rows.total > 0) {
      console.log(`Cleaning ${rows.total} rows from table '${tableId}'...`);
      for (const row of rows.rows) {
        await t.deleteRow({ databaseId: "digr", tableId, rowId: row.$id });
        console.log(`  ✓ Deleted row '${row.$id}' from '${tableId}'`);
      }
    } else {
      console.log(`Table '${tableId}' is clean (0 rows).`);
    }
  }

  // 3. Clean storage buckets
  const buckets = ["receipts", "results", "partials"];
  for (const bucketId of buckets) {
    const files = await s.listFiles(bucketId);
    if (files.total > 0) {
      console.log(`Cleaning ${files.total} files from bucket '${bucketId}'...`);
      for (const file of files.files) {
        await s.deleteFile(bucketId, file.$id);
        console.log(`  ✓ Deleted file '${file.$id}' from '${bucketId}'`);
      }
    } else {
      console.log(`Bucket '${bucketId}' is clean (0 files).`);
    }
  }

  console.log("\n✨ Cleanup finished!");
}

clean().catch(console.error);
