import { build } from "esbuild";
import * as path from "path";
import * as fs from "fs";

const functions = ["on-user-create", "submit-topup", "approve-topup"];

async function bundleFunctions() {
  console.log("📦 Bundling Appwrite Functions with esbuild...\n");

  for (const fn of functions) {
    const entry = path.resolve(__dirname, `../src/functions/${fn}/src/main.ts`);
    const outdir = path.resolve(__dirname, `../src/functions/${fn}/dist`);

    if (!fs.existsSync(outdir)) {
      fs.mkdirSync(outdir, { recursive: true });
    }

    console.log(`Bundling ${fn}...`);
    await build({
      entryPoints: [entry],
      outfile: path.join(outdir, "index.js"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
    });

    // Write a minimal package.json in function dir for Appwrite runtime
    const pkgPath = path.resolve(__dirname, `../src/functions/${fn}/package.json`);
    const pkgContent = {
      name: fn,
      version: "1.0.0",
      main: "dist/index.js",
      dependencies: {
        "node-appwrite": "^29.2.0",
      },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkgContent, null, 2));

    console.log(`  ✓ Bundled ${fn} -> dist/index.js + package.json`);
  }

  console.log("\n🎉 All functions bundled successfully!");
}

bundleFunctions().catch(console.error);
