import { Client, Functions } from "node-appwrite";
import { execSync } from "child_process";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config({ path: ".env.local" });

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;
const apiKey = process.env.APPWRITE_API_KEY!;

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const fnService = new Functions(client);

async function deploy() {
  console.log("🚀 Building and Deploying Appwrite Functions...\n");

  // 1. Build all functions bundle
  console.log("📦 Bundling functions...");
  execSync("npm run build:functions", { stdio: "inherit" });

  // 2. Read appwrite.json
  const configPath = path.resolve(__dirname, "../appwrite.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  // 3. Ensure remote functions exist and match settings
  console.log("\n🔍 Checking remote function configurations...");
  const remoteList = await fnService.list();
  const remoteMap = new Map(remoteList.functions.map((f: any) => [f.$id, f]));

  for (const fn of config.functions) {
    const remote = remoteMap.get(fn.$id);
    if (!remote) {
      console.log(`  + Creating remote function: ${fn.$id} (runtime: ${fn.runtime})...`);
      await fnService.create({
        functionId: fn.$id,
        name: fn.name,
        runtime: fn.runtime,
        execute: fn.execute,
        events: fn.events,
        scopes: fn.scopes,
        timeout: fn.timeout,
        entrypoint: fn.entrypoint,
        commands: fn.commands,
      });
      console.log(`  ✓ Function ${fn.$id} created.`);
    } else {
      console.log(`  • Updating remote function settings: ${fn.$id}...`);
      await fnService.update({
        functionId: fn.$id,
        name: fn.name,
        runtime: fn.runtime,
        execute: fn.execute,
        events: fn.events,
        scopes: fn.scopes,
        timeout: fn.timeout,
        entrypoint: fn.entrypoint,
        commands: fn.commands,
      });
      console.log(`  ✓ Function ${fn.$id} settings updated.`);
    }
  }

  // 4. Push code via appwrite-cli
  console.log("\n🚀 Pushing function code to Appwrite Cloud via appwrite-cli...");
  execSync("npx appwrite-cli push function --all --force", { stdio: "inherit" });

  console.log("\n✅ All functions successfully deployed to Appwrite Cloud!");
}

deploy().catch((err) => {
  console.error("❌ Deployment failed:", err);
  process.exit(1);
});
