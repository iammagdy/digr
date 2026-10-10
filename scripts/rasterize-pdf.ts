import puppeteer from "puppeteer-core";
import * as fs from "fs";
import * as path from "path";

export async function rasterizePdfToPng(pdfPath: string, pngPath: string): Promise<void> {
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfBase64 = pdfBytes.toString("base64");

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
      <style>
        body { margin: 0; background: #fff; }
        canvas { display: block; margin: 0 auto; }
      </style>
    </head>
    <body>
      <canvas id="pdf-canvas"></canvas>
      <script>
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const pdfData = atob("${pdfBase64}");
        const uint8Array = new Uint8Array(pdfData.length);
        for (let i = 0; i < pdfData.length; i++) {
          uint8Array[i] = pdfData.charCodeAt(i);
        }

        pdfjsLib.getDocument({ data: uint8Array }).promise.then(function(pdf) {
          return pdf.getPage(1);
        }).then(function(page) {
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas = document.getElementById('pdf-canvas');
          const context = canvas.getContext('2d');
          canvas.height = viewport.height;
          canvas.width = viewport.width;

          const renderContext = {
            canvasContext: context,
            viewport: viewport
          };
          return page.render(renderContext).promise;
        }).then(function() {
          window.RENDER_DONE = true;
        }).catch(function(err) {
          console.error(err);
          window.RENDER_ERROR = err.message;
        });
      </script>
    </body>
    </html>
  `;

  const browser = await puppeteer.launch({
    executablePath: edgePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await page.waitForFunction(() => (window as any).RENDER_DONE || (window as any).RENDER_ERROR, { timeout: 15000 });
    const isError = await page.evaluate(() => (window as any).RENDER_ERROR);
    if (isError) throw new Error("PDF.js render error: " + isError);

    const canvasElement = await page.$("#pdf-canvas");
    if (!canvasElement) throw new Error("Canvas element not found");
    await canvasElement.screenshot({ path: pngPath });
    console.log(`✅ Successfully rasterized ${pdfPath} to ${pngPath}`);
  } finally {
    await browser.close();
  }
}

rasterizePdfToPng("test_spaces.pdf", "test_spaces.png").catch((err) => {
  console.error("Rasterize error:", err);
  process.exit(1);
});
