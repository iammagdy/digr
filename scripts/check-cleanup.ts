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

async function check() {
  console.log("🔍 Checking cleanup status across all Appwrite services...\n");

  const users = await u.list();
  console.log(`Users remaining: ${users.total}`);
  for (const user of users.users) {
    console.log(`  - User: ${user.$id} (${user.email})`);
  }

  const dynamicTables = [
    "profiles",
    "jobs",
    "job_events",
    "credit_ledger",
    "topups",
    "job_calls",
    "jobs_internal",
  ];

  console.log("\nDynamic Tables:");
  for (const tableId of dynamicTables) {
    const r = await t.listRows({ databaseId: "digr", tableId });
    console.log(`  - Table '${tableId}': ${r.total} rows`);
  }

  const buckets = ["receipts", "results", "partials"];
  console.log("\nStorage Buckets:");
  for (const bucketId of buckets) {
    const f = await s.listFiles(bucketId);
    console.log(`  - Bucket '${bucketId}': ${f.total} files`);
  }

  console.log("\nSeed Configuration Tables (Permanent):");
  for (const tableId of ["templates", "templates_private", "settings", "settings_public"]) {
    const r = await t.listRows({ databaseId: "digr", tableId });
    console.log(`  - Table '${tableId}': ${r.total} rows`);
  }
}

check().catch(console.error);
