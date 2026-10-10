import PDFDocument from "pdfkit";

const doc = new PDFDocument();
doc.registerFont("ArabicRegular", "src/assets/fonts/IBMPlexSansArabic-Regular.ttf");
doc.registerFont("ArabicBold", "src/assets/fonts/IBMPlexSansArabic-Bold.ttf");

doc.font("ArabicRegular").fontSize(12);
console.log("Regular font width of space ' ':", doc.widthOfString(" "));
console.log("Regular font width of 'نتائج':", doc.widthOfString("نتائج"));
console.log("Regular font width of 'استخراج':", doc.widthOfString("استخراج"));
console.log("Regular font width of 'نتائج استخراج':", doc.widthOfString("نتائج استخراج"));
console.log("Regular font width of 'نتائجاستخراج':", doc.widthOfString("نتائجاستخراج"));

doc.font("ArabicBold").fontSize(12);
console.log("Bold font width of space ' ':", doc.widthOfString(" "));
console.log("Bold font width of 'نتائج استخراج':", doc.widthOfString("نتائج استخراج"));
console.log("Bold font width of 'نتائجاستخراج':", doc.widthOfString("نتائجاستخراج"));
