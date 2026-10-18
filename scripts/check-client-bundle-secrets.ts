import * as fs from "fs";
import * as path from "path";

/**
 * CI/CD & Build Guard: Scans the Next.js client bundle for leaked secrets or private env vars.
 * Enforces that OPENAI_API_KEY, APPWRITE_API_KEY, TREG_TOKEN, etc., NEVER leak into client-side JS.
 */

const STATIC_DIR = path.join(process.cwd(), ".next", "static");

// Secret detection patterns
const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "OpenAI Secret Key", regex: /sk-[a-zA-Z0-9_-]{20,}/g },
  { name: "Anthropic Secret Key", regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
  { name: "TREG Secret Token", regex: /treg_[a-zA-Z0-9_-]{16,}/g },
  { name: "Appwrite Server API Key Header/Literal", regex: /X-Appwrite-Key["']?\s*:\s*["'][a-zA-Z0-9_-]{32,}["']/g },
  { name: "Generic Private Env Reference", regex: /process\.env\.OPENAI_API_KEY/g },
  { name: "Server Anthropic Key Leaked", regex: /process\.env\.ANTHROPIC_API_KEY/g },
  { name: "Server-only Variable Leaked", regex: /process\.env\.APPWRITE_API_KEY/g },
  { name: "Server TREG Token Leaked", regex: /process\.env\.TREG_TOKEN/g },
  { name: "Provider Keys Encryption Key Leaked", regex: /process\.env\.PROVIDER_KEYS_ENCRYPTION_KEY/g },
  { name: "Supabase Service Role Key Leaked", regex: /process\.env\.SUPABASE_SERVICE_ROLE_KEY/g },
  { name: "Cron Secret Leaked", regex: /process\.env\.CRON_SECRET/g },
];

function getAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".json"))) {
      files.push(fullPath);
    }
  }

  return files;
}

export function runBundleSecretCheck(): { passed: boolean; violations: string[] } {
  console.log("🔍 Scanning Next.js client bundle (.next/static) for secrets...");

  if (!fs.existsSync(STATIC_DIR)) {
    console.warn("⚠️ .next/static directory not found. Run 'next build' first.");
    return { passed: true, violations: [] };
  }

  const files = getAllFiles(STATIC_DIR);
  console.log(`  Found ${files.length} client-side static bundle files.`);

  const violations: string[] = [];

  for (const file of files) {
    const relativePath = path.relative(process.cwd(), file);
    const content = fs.readFileSync(file, "utf8");

    for (const rule of FORBIDDEN_PATTERNS) {
      const match = content.match(rule.regex);
      if (match) {
        violations.push(`[${rule.name}] in ${relativePath}: "${match[0].slice(0, 30)}..."`);
      }
    }
  }

  if (violations.length > 0) {
    console.error("\n❌ CRITICAL SECURITY ERROR: Secret patterns detected in client bundle!");
    for (const v of violations) {
      console.error(`  - ${v}`);
    }
    return { passed: false, violations };
  }

  console.log("✅ Zero client bundle secrets detected. All client JS files are fully clean.\n");
  return { passed: true, violations: [] };
}

if (require.main === module || process.argv[1]?.includes("check-client-bundle-secrets")) {
  const result = runBundleSecretCheck();
  if (!result.passed) {
    process.exit(1);
  }
}
