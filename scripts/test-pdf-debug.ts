import PDFDocument from "pdfkit";
import * as fs from "fs";

const doc = new PDFDocument({ size: "A4" });
doc.registerFont("Arabic", "src/assets/fonts/IBMPlexSansArabic-Regular.ttf");
const writeStream = fs.createWriteStream("test_spaces.pdf");
doc.pipe(writeStream);

doc.font("Arabic").fontSize(18).text("نتائج استخراج البيانات", 100, 100);
doc.end();

writeStream.on("finish", () => {
  console.log("PDF created successfully");
});
