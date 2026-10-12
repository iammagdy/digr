import { Client, TablesDB, Storage, Users, Query } from "node-appwrite";

const RESULTS_BUCKET = "results";
const BATCH = 10;

async function removeFile(storage: Storage, fileId?: string | null) {
  if (!fileId) return;
  try { await storage.deleteFile({ bucketId: RESULTS_BUCKET, fileId }); } catch (e: any) { if (e?.code !== 404) throw e; }
}

async function deleteAll(tables: TablesDB, tableId: string, queries: string[]) {
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await tables.listRows({ databaseId: "digr", tableId, queries: [...queries, Query.limit(100)] });
    if (!page.rows.length) return;
    for (const row of page.rows) await tables.deleteRow({ databaseId: "digr", tableId, rowId: row.$id });
    if (page.rows.length < 100) return;
  }
}

/**
 * Scheduled daily. Removes accounts whose 30-day grace period elapsed: research files, conversations and
 * notifications go; financial records (ledger, top-ups with receipts, job accounting) stay for the legal retention period.
 */
export default async ({ res, log, error }: any) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
    .setKey(process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY!);
  const tables = new TablesDB(client);
  const storage = new Storage(client);
  const users = new Users(client);

  let purged = 0;
  try {
    const due = await tables.listRows({
      databaseId: "digr", tableId: "profiles",
      queries: [Query.lessThanEqual("deletionScheduledFor", new Date().toISOString()), Query.limit(BATCH)],
    });

    for (const profile of due.rows as any[]) {
      const userId: string = profile.userId;
      try {
        const jobs = await tables.listRows({ databaseId: "digr", tableId: "jobs", queries: [Query.equal("userId", userId), Query.limit(100)] });
        for (const job of jobs.rows as any[]) {
          for (const ext of ["xlsx", "pdf", "csv"]) await removeFile(storage, `${ext}_${job.$id}`);
          await removeFile(storage, job.resultFileId);
          const versions = await tables.listRows({ databaseId: "digr", tableId: "artifact_versions", queries: [Query.equal("jobId", job.$id), Query.limit(100)] });
          for (const v of versions.rows as any[]) {
            await removeFile(storage, v.fileIdXlsx); await removeFile(storage, v.fileIdPdf); await removeFile(storage, v.fileIdCsv);
            await tables.deleteRow({ databaseId: "digr", tableId: "artifact_versions", rowId: v.$id });
          }
        }
        await deleteAll(tables, "messages", [Query.equal("userId", userId)]);
        await deleteAll(tables, "notes", [Query.equal("userId", userId)]);
        await deleteAll(tables, "conversations", [Query.equal("userId", userId)]);
        await deleteAll(tables, "notifications", [Query.equal("userId", userId)]);
        await users.delete({ userId });
        await tables.deleteRow({ databaseId: "digr", tableId: "profiles", rowId: profile.$id });
        purged += 1;
        log(`Purged account ${userId}`);
      } catch (e: any) {
        error(`Failed to purge ${userId}: ${e.message}`);
      }
    }
    return res.json({ success: true, purged });
  } catch (e: any) {
    error(`purge-deleted-accounts failed: ${e.message}`);
    return res.json({ success: false, error: "purge failed" }, 500);
  }
};
