import { Client, TablesDB } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const client = new Client()
  .setEndpoint("https://cloud.appwrite.io/v1")
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
  .setKey(process.env.APPWRITE_API_KEY!);

const tables = new TablesDB(client);

async function main() {
  const t = await tables.getTable({ databaseId: "digr", tableId: "profiles" });
  console.log("Profiles existing columns:", (t as any).columns?.map((c: any) => c.key));

  const cols = (t as any).columns?.map((c: any) => c.key) || [];

  if (!cols.includes("persona")) {
    console.log("Creating persona column...");
    await tables.createVarcharColumn({
      databaseId: "digr",
      tableId: "profiles",
      key: "persona",
      size: 32,
      required: false,
      default: "student",
    });
    console.log("✓ Created persona");
  }

  if (!cols.includes("purposes")) {
    console.log("Creating purposes column...");
    await tables.createVarcharColumn({
      databaseId: "digr",
      tableId: "profiles",
      key: "purposes",
      size: 512,
      required: false,
      default: "[]",
    });
    console.log("✓ Created purposes");
  }

  if (!cols.includes("topic")) {
    console.log("Creating topic column...");
    await tables.createVarcharColumn({
      databaseId: "digr",
      tableId: "profiles",
      key: "topic",
      size: 256,
      required: false,
      default: "",
    });
    console.log("✓ Created topic");
  }

  if (!cols.includes("onboardingCompleted")) {
    console.log("Creating onboardingCompleted column...");
    await tables.createBooleanColumn({
      databaseId: "digr",
      tableId: "profiles",
      key: "onboardingCompleted",
      required: false,
      default: false,
    });
    console.log("✓ Created onboardingCompleted");
  }

  const m = await tables.getTable({ databaseId: "digr", tableId: "messages" });
  const mCols = (m as any).columns?.map((c: any) => c.key) || [];
  if (!mCols.includes("promptVersion")) {
    console.log("Creating promptVersion column on messages...");
    await tables.createVarcharColumn({
      databaseId: "digr",
      tableId: "messages",
      key: "promptVersion",
      size: 32,
      required: false,
      default: "2.0.0",
    });
    console.log("✓ Created promptVersion on messages");
  }
}

main().catch(console.error);
