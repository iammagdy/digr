import http from "http";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-core";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function main() {
  const pdfBytes = fs.readFileSync("test_full_report.pdf");

  // Spin up temporary local server on port 3088
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=report.pdf",
    });
    res.end(pdfBytes);
  });

  await new Promise<void>((resolve) => server.listen(3088, () => resolve()));
  console.log("Local PDF server running at http://localhost:3088");

  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 1400, deviceScaleFactor: 2 });
    await page.goto("http://localhost:3088", { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 2000));
    await page.screenshot({ path: "test_full_report_edge.png" });
    console.log("Saved test_full_report_edge.png");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(console.error);
