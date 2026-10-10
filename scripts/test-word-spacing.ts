import PDFDocument from "pdfkit";
import fs from "fs";

const doc = new PDFDocument({ size: "A4" });
doc.registerFont("ArabicRegular", "src/assets/fonts/IBMPlexSansArabic-Regular.ttf");
doc.registerFont("ArabicBold", "src/assets/fonts/IBMPlexSansArabic-Bold.ttf");

const stream = fs.createWriteStream("test_spacing_compare.pdf");
doc.pipe(stream);

// Without wordSpacing
doc.font("ArabicBold").fontSize(16).text("نتائج استخراج البيانات العامة (افتراضي بدون تباعد)", 50, 50, { align: "right" });

// With wordSpacing: 3
doc.font("ArabicBold").fontSize(16).text("نتائج استخراج البيانات العامة (مع تباعد كلمات 3)", 50, 100, { align: "right", wordSpacing: 3 });

// With wordSpacing: 4
doc.font("ArabicBold").fontSize(16).text("نتائج استخراج البيانات العامة (مع تباعد كلمات 4)", 50, 150, { align: "right", wordSpacing: 4 });

doc.end();

stream.on("finish", () => {
  console.log("PDF test_spacing_compare.pdf created");
});
