import { Client, TablesDB, Storage } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const client = new Client()
  .setEndpoint("https://cloud.appwrite.io/v1")
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482")
  .setKey(process.env.APPWRITE_API_KEY!);

const tables = new TablesDB(client);
const storage = new Storage(client);

async function main() {
  const jobId = "6aca16460023863cfb01";
  console.log(`Inspecting job ${jobId}...`);
  const job = await tables.getRow({ databaseId: "digr", tableId: "jobs", rowId: jobId });
  console.log("Job Record:", JSON.stringify(job, null, 2));

  if ((job as any).resultFileId) {
    const fileId = (job as any).resultFileId;
    console.log(`Fetching result file: ${fileId} from bucket 'results'...`);
    try {
      const buf = await storage.getFileDownload("results", fileId);
      console.log("File downloaded bytes:", buf.byteLength);
    } catch (err: any) {
      console.error("Error reading file:", err.message);
    }
  }
  const quotes = await tables.listRows({
    databaseId: "digr",
    tableId: "plans_quotes",
  });
  console.log(`\n--- ALL QUOTES (${quotes.total}) ---`);
  for (const q of quotes.rows) {
    console.log(JSON.stringify({
      id: q.$id,
      userId: (q as any).userId,
      status: (q as any).status,
      itemsJson: (q as any).itemsJson,
      createdAt: (q as any).createdAt,
    }, null, 2));
  }

  const msgs = await tables.listRows({
    databaseId: "digr",
    tableId: "messages",
  });
  console.log(`\n--- ALL CHAT MESSAGES (${msgs.total}) ---`);
  for (const m of msgs.rows) {
    console.log(JSON.stringify({
      id: m.$id,
      role: (m as any).role,
      content: ((m as any).content || "").slice(0, 150),
      createdAt: (m as any).createdAt,
    }, null, 2));
  }
}

main().catch(console.error);
