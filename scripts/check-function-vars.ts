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
  const fList = await functions.list();
  for (const f of fList.functions) {
    const vars = await functions.listVariables({ functionId: f.$id });
    console.log(`\nFunction ${f.name} (${f.$id}) has ${vars.total} variables:`);
    for (const v of vars.variables) {
      console.log(`  - ${v.key} (IsSet: ${Boolean(v.value)})`);
    }
  }
}

main().catch(console.error);
