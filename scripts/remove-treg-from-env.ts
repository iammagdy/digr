import * as fs from "fs";
import * as path from "path";

const envPath = path.resolve(".env.local");
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf-8");
  const lines = content.split("\n");
  const filtered = lines.filter((line) => !line.trim().startsWith("TREG_TOKEN=") && !line.trim().startsWith("TREG_API_KEY="));
  fs.writeFileSync(envPath, filtered.join("\n"));
  console.log("✓ TREG_TOKEN removed from .env.local.");
} else {
  console.log(".env.local not found.");
}
