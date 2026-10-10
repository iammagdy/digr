import puppeteer from "puppeteer-core";
import * as path from "path";

async function main() {
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const htmlPath = path.resolve("scripts", "test-embed-pdf.html");
  const fileUrl = `file://${htmlPath.replace(/\\/g, "/")}`;

  console.log("Opening HTML in Edge:", fileUrl);
  const browser = await puppeteer.launch({
    executablePath: edgePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 1400, deviceScaleFactor: 2 });
  await page.goto(fileUrl, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 2000));

  const outPath = path.resolve("pdf_preview.png");
  await page.screenshot({ path: outPath });
  console.log("Saved screenshot to:", outPath);

  await browser.close();
}

main().catch(console.error);
