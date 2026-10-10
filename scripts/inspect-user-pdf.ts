import { Client, Storage } from "node-appwrite";
import * as dotenv from "dotenv";
import * as fs from "fs";
import puppeteer from "puppeteer-core";
import * as path from "path";

dotenv.config({ path: ".env.local" });

const client = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1")
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482")
  .setKey(process.env.APPWRITE_API_KEY!);

const storage = new Storage(client);
const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function main() {
  const fileId = "pdf_6aca16460023863cfb01";
  console.log(`Downloading ${fileId} from Appwrite storage...`);
  const buf = await storage.getFileDownload({ bucketId: "results", fileId });
  fs.writeFileSync("user_job.pdf", Buffer.from(buf));
  console.log("Saved user_job.pdf");

  // Screenshot with Edge
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--headless=new",
      "--enable-features=PdfOopif",
      "--allow-file-access-from-files",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1800, deviceScaleFactor: 1 });
    const pdfPath = path.resolve("user_job.pdf");
    await page.goto(`file://${pdfPath}`, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 2000));
    await page.screenshot({ path: "user_job_screenshot.png" });
    console.log("Saved user_job_screenshot.png");
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
