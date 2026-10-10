import { Client, Functions } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const functions = new Functions(client);

async function main() {
  const res = await functions.list();
  console.log(`Total functions deployed: ${res.total}`);
  for (const f of res.functions) {
    console.log(`- ID: ${f.$id}`);
    console.log(`  Name: ${f.name}`);
    console.log(`  Runtime: ${f.runtime}`);
    console.log(`  Execute Permissions: [${f.execute.join(", ")}]`);
    console.log(`  Events: [${f.events?.join(", ") || ""}]`);
    console.log(`  Schedule: ${f.schedule || "None"}`);
    console.log("---");
  }
}

main().catch(console.error);
