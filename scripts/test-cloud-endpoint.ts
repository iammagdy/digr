import { Client, TablesDB } from "node-appwrite";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
  console.log("Connecting to https://cloud.appwrite.io/v1 ...");
  const client = new Client()
    .setEndpoint("https://cloud.appwrite.io/v1")
    .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
    .setKey(process.env.APPWRITE_API_KEY!);
  const tables = new TablesDB(client);
  const res = await tables.listRows({ databaseId: "digr", tableId: "templates" });
  console.log("SUCCESS! Total templates:", res.total);
}

main().catch(console.error);
