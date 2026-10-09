import { Client, TablesDB } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const client = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
  .setKey(process.env.APPWRITE_API_KEY!);

const tables = new TablesDB(client);

async function check() {
  for (const tableId of ["templates", "templates_private", "settings", "settings_public"]) {
    try {
      const res = await tables.listRows({ databaseId: "digr", tableId });
      console.log(`Table: ${tableId} -> Total rows: ${res.total}`);
      for (const row of res.rows) {
        if (tableId === "settings") {
          console.log(`  Row ${row.$id}: { key: "${(row as any).key}", usdToEgp: [PROTECTED], markup: [PROTECTED], minMarginThreshold: [PROTECTED] }`);
        } else if (tableId === "templates_private") {
          console.log(`  Row ${row.$id}: { slug: "${(row as any).slug}", tregEndpointId: [PROTECTED], tregMethod: "${(row as any).tregMethod}", estimatedCostUsd: [PROTECTED], maxCostUsd: [PROTECTED] }`);
        } else {
          console.log(`  Row ${row.$id}:`, JSON.stringify(row, (k, v) => k.startsWith("$") ? undefined : v));
        }
      }
    } catch (err: any) {
      console.log(`Table: ${tableId} -> Error: ${err.message}`);
    }
  }
}

check().catch(console.error);
