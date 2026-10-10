import { Client, Storage } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const endpoint = "https://cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const storage = new Storage(client);

async function main() {
  console.log("=== PHASE A CLEANUP: STORAGE BUCKETS ===");

  // 1. Ensure server-only bucket `job_data` exists (permissions empty = server only)
  try {
    await storage.getBucket("job_data");
    console.log("✓ Bucket 'job_data' already exists.");
  } catch {
    console.log("Creating server-only bucket 'job_data'...");
    await storage.createBucket(
      "job_data",
      "Job Data",
      [], // permissions empty: no client read/write
      false, // fileSecurity false (no per-file permissions needed since server-only)
      true,  // enabled
      52428800, // 50MB
      ["json"]
    );
    console.log("✓ Bucket 'job_data' created successfully.");
  }

  // 2. Update `results` bucket to hold ONLY user-facing extensions: ["xlsx", "pdf", "csv"]
  console.log("Updating 'results' bucket allowed extensions to ['xlsx', 'pdf', 'csv']...");
  const resBucket = await storage.updateBucket(
    "results",
    "Results",
    undefined,
    true,
    undefined,
    undefined,
    ["xlsx", "pdf", "csv"]
  );
  console.log("✓ 'results' bucket updated. Allowed extensions:", resBucket.allowedFileExtensions);

  // 3. Move any json file from results to job_data
  try {
    const files = await storage.listFiles("results");
    for (const f of files.files) {
      if (f.name.endsWith(".json") || f.$id.startsWith("json_")) {
        console.log(`Moving ${f.$id} from 'results' to 'job_data'...`);
        const fileBuf = await storage.getFileDownload("results", f.$id);
        const uploadFile = new File([new Uint8Array(fileBuf)], f.name, { type: "application/json" });
        try {
          await storage.deleteFile("job_data", f.$id);
        } catch {}
        await storage.createFile("job_data", f.$id, uploadFile);
        await storage.deleteFile("results", f.$id);
        console.log(`✓ Moved ${f.$id} to 'job_data' and removed from 'results'.`);
      }
    }
  } catch (err: any) {
    console.warn("Notice during file migration:", err.message);
  }

  console.log("✓ Phase A Storage cleanup completed.");
}

main().catch(console.error);
