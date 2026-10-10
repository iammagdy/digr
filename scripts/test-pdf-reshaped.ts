import PDFDocument from "pdfkit";
import fs from "fs";
// @ts-ignore
import reshaper from "arabic-persian-reshaper";
import bidiFactory from "bidi-js";

const bidi = bidiFactory();

function formatArabicRtl(text: string): string {
  if (!text) return "";
  const hasArabic = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
  if (!hasArabic) return text;
  const reshaped = reshaper.ArabicShaper.convertArabic(text);
  const embeddingLevels = bidi.getEmbeddingLevels(reshaped, "rtl");
  return bidi.getReorderedString(reshaped, embeddingLevels);
}

const doc = new PDFDocument({ size: "A4" });
doc.registerFont("ArabicRegular", "src/assets/fonts/IBMPlexSansArabic-Regular.ttf");
doc.registerFont("ArabicBold", "src/assets/fonts/IBMPlexSansArabic-Bold.ttf");

const stream = fs.createWriteStream("test_reshaped_render.pdf");
doc.pipe(stream);

doc.font("ArabicBold").fontSize(18).text(formatArabicRtl("منصة Digr لاستخراج البيانات العامة"), 50, 50, { align: "right" });
doc.font("ArabicRegular").fontSize(12).text(formatArabicRtl("ملخص استخراج البيانات (1 سجل)"), 50, 90, { align: "right" });
doc.font("ArabicRegular").fontSize(12).text(formatArabicRtl("عينة من السجلات المستخرجة :"), 50, 120, { align: "right" });
doc.font("ArabicRegular").fontSize(12).text(formatArabicRtl("ملاحظة منهجية : هذه البيانات عامة ومتاحة علناً."), 50, 150, { align: "right" });
doc.font("ArabicRegular").fontSize(12).text(formatArabicRtl("الحساب المستهدف : Megz (@iam_megz)"), 50, 180, { align: "right" });
doc.font("ArabicRegular").fontSize(12).text(formatArabicRtl("إجمالي المتابعين: 162,400,000 متابع"), 50, 210, { align: "right" });
doc.font("ArabicRegular").fontSize(12).text(formatArabicRtl("حالة التوثيق: موثق رسمياً ✓"), 50, 240, { align: "right" });

doc.end();

stream.on("finish", () => {
  console.log("PDF with reshaped text created successfully");
});
