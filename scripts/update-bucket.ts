import { Client, Storage } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function main() {
  const client = new Client()
    .setEndpoint("https://cloud.appwrite.io/v1")
    .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
    .setKey(process.env.APPWRITE_API_KEY!);

  const storage = new Storage(client);
  const b = await storage.updateBucket(
    "results",
    "Results",
    undefined,
    true,
    undefined,
    undefined,
    ["xlsx", "pdf", "csv", "json"]
  );
  console.log("✓ Results bucket updated! Allowed extensions:", b.allowedFileExtensions);
}

main().catch(console.error);
