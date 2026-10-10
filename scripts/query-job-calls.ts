import { Client, TablesDB } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const client = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1")
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482")
  .setKey(process.env.APPWRITE_API_KEY!);

const tables = new TablesDB(client);

async function main() {
  const calls = await tables.listRows({
    databaseId: "digr",
    tableId: "job_calls",
  });
  console.log(`Total rows in job_calls: ${calls.total}`);
  for (const c of calls.rows) {
    console.log(JSON.stringify({
      id: c.$id,
      jobId: (c as any).jobId,
      endpointId: (c as any).endpointId,
      costMicro: (c as any).costMicro,
      status: (c as any).status,
      httpStatus: (c as any).httpStatus,
      createdAt: (c as any).createdAt,
    }, null, 2));
  }

  const jobs = await tables.listRows({
    databaseId: "digr",
    tableId: "jobs",
  });
  console.log(`\n--- ALL JOBS (${jobs.total}) ---`);
  for (const j of jobs.rows) {
    console.log(JSON.stringify({
      id: j.$id,
      userId: (j as any).userId,
      templateSlug: (j as any).templateSlug,
      status: (j as any).status,
      reservedCredits: (j as any).reservedCredits,
      chargedCredits: (j as any).chargedCredits,
      rowsCollected: (j as any).rowsCollected,
      createdAt: (j as any).createdAt,
    }, null, 2));
  }

  const ledger = await tables.listRows({
    databaseId: "digr",
    tableId: "credit_ledger",
  });
  console.log(`\n--- ALL LEDGER ROWS (${ledger.total}) ---`);
  for (const l of ledger.rows) {
    console.log(JSON.stringify({
      id: l.$id,
      type: (l as any).type,
      delta: (l as any).delta,
      jobId: (l as any).jobId,
      note: (l as any).note,
    }, null, 2));
  }
}

main().catch(console.error);
