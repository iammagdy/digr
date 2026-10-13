import PDFDocument from "pdfkit";
import * as fs from "fs";
import * as path from "path";

// True BiDi-aware line builder:
// Reorders Arabic words for RTL rendering while preserving LTR text (English, URLs, Numbers)
export function formatArabicRtl(text: string): string {
  if (!text) return "";
  
  // If the text contains no Arabic characters, keep it as-is
  const hasArabic = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
  if (!hasArabic) return text;

  // If it's a label + value like: "النبذة التعريفية : Your next discovery is waiting on TikTok."
  const colonMatch = text.match(/^(.*?)\s*:\s*(.*)$/);
  if (colonMatch) {
    const label = colonMatch[1];
    const val = colonMatch[2];
    const valHasArabic = /[\u0600-\u06FF]/.test(val);
    if (!valHasArabic) {
      const revLabel = label.split(" ").reverse().join(" ");
      return `${val} : ${revLabel}`;
    }
  }

  // Split into tokens by space and reverse
  return text.split(" ").reverse().join(" ");
}

export function generatePdfReport(data: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 30, left: 35, right: 35 },
      info: {
        Title: "تقرير استخراج بيانات Diger",
        Author: "Diger",
        Subject: "Data Report",
        Creator: "Diger Data Platform",
      },
    });

    const fontRegular = path.join("src", "assets", "fonts", "IBMPlexSansArabic-Regular.ttf");
    const fontBold = path.join("src", "assets", "fonts", "IBMPlexSansArabic-Bold.ttf");

    doc.registerFont("ArabicRegular", fontRegular);
    doc.registerFont("ArabicBold", fontBold);

    const buffers: Buffer[] = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const profile = data.profile || {};
    const metadata = data.metadata || {};
    const dateStr = metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - 70;

    // 1. Header Banner
    doc.rect(35, 30, contentWidth, 58).fill("#0F172A"); // Dark slate

    doc.font("ArabicBold").fontSize(17).fillColor("#FFFFFF");
    doc.text(formatArabicRtl("منصة Diger لاستخراج البيانات العامة"), 50, 40, {
      width: contentWidth - 30,
      align: "right",
    });

    doc.font("ArabicRegular").fontSize(10).fillColor("#94A3B8");
    doc.text(formatArabicRtl(`تقرير ملف تيك توك الشخصي • تاريخ الاستخراج: ${dateStr}`), 50, 64, {
      width: contentWidth - 30,
      align: "right",
    });

    let currentY = 100;

    // 2. Account Profile Overview Card
    doc.rect(35, currentY, contentWidth, 75).fillAndStroke("#F8FAFC", "#E2E8F0");

    doc.font("ArabicBold").fontSize(12).fillColor("#0F172A");
    doc.text(formatArabicRtl(`الحساب المستهدف : ${profile.nickname || "—"} (@${profile.uniqueId || "—"})`), 50, currentY + 10, {
      width: contentWidth - 30,
      align: "right",
    });

    doc.font("ArabicRegular").fontSize(9.5).fillColor("#334155");
    const bioText = profile.signature ? `النبذة التعريفية : ${profile.signature}` : "النبذة التعريفية : لا توجد نبذة مسجلة";
    doc.text(formatArabicRtl(bioText), 50, currentY + 31, {
      width: contentWidth - 30,
      align: "right",
    });

    const verifiedText = profile.verified ? "موثق رسميًا ✓" : "غير موثق";
    const bioLinkText = profile.bioLink ? profile.bioLink : "لا يوجد رابط";
    doc.text(formatArabicRtl(`حالة التوثيق : ${verifiedText}   |   رابط البايو : ${bioLinkText}`), 50, currentY + 52, {
      width: contentWidth - 30,
      align: "right",
    });

    currentY += 90;

    // 3. Key Metric Stat Boxes (4 Columns)
    doc.font("ArabicBold").fontSize(11).fillColor("#1E293B");
    doc.text(formatArabicRtl("المؤشرات الرقمية الرئيسية :"), 35, currentY, {
      width: contentWidth,
      align: "right",
    });
    currentY += 18;

    const boxGap = 8;
    const boxWidth = (contentWidth - boxGap * 3) / 4;
    const boxHeight = 58;

    const stats = [
      { label: formatArabicRtl("المتابعون"), val: Number(profile.followerCount || 0).toLocaleString("en-US") },
      { label: formatArabicRtl("إجمالي الإعجابات"), val: Number(profile.heartCount || 0).toLocaleString("en-US") },
      { label: formatArabicRtl("مقاطع الفيديو"), val: Number(profile.videoCount || 0).toLocaleString("en-US") },
      { label: formatArabicRtl("الحسابات المتابَعة"), val: Number(profile.followingCount || 0).toLocaleString("en-US") },
    ];

    stats.forEach((st, idx) => {
      const bx = 35 + idx * (boxWidth + boxGap);
      doc.rect(bx, currentY, boxWidth, boxHeight).fillAndStroke("#FFFFFF", "#CBD5E1");

      doc.font("ArabicRegular").fontSize(8.5).fillColor("#64748B");
      doc.text(st.label, bx, currentY + 10, { width: boxWidth, align: "center" });

      doc.font("ArabicBold").fontSize(12).fillColor("#0F172A");
      doc.text(st.val, bx, currentY + 28, { width: boxWidth, align: "center" });
    });

    currentY += 75;

    // 4. Detailed Data Table
    doc.font("ArabicBold").fontSize(11).fillColor("#1E293B");
    doc.text(formatArabicRtl("جدول البيانات التفصيلية :"), 35, currentY, {
      width: contentWidth,
      align: "right",
    });
    currentY += 18;

    const tableRows = [
      { field: formatArabicRtl("اسم المستخدم"), value: `@${profile.uniqueId || "—"}` },
      { field: formatArabicRtl("الاسم المعروض"), value: formatArabicRtl(profile.nickname || "—") },
      { field: formatArabicRtl("المعرف الرقمي للحساب"), value: profile.id || "—" },
      { field: formatArabicRtl("إجمالي عدد المتابعين"), value: Number(profile.followerCount || 0).toLocaleString("en-US") },
      { field: formatArabicRtl("إجمالي عدد الإعجابات"), value: Number(profile.heartCount || 0).toLocaleString("en-US") },
      { field: formatArabicRtl("عدد مقاطع الفيديو المنشورة"), value: Number(profile.videoCount || 0).toLocaleString("en-US") },
      { field: formatArabicRtl("عدد الحسابات المتابَعة"), value: Number(profile.followingCount || 0).toLocaleString("en-US") },
      { field: formatArabicRtl("حالة توثيق الحساب"), value: profile.verified ? formatArabicRtl("موثق رسميًا ✓") : formatArabicRtl("غير موثق") },
      { field: formatArabicRtl("تاريخ ووقت الاستخراج"), value: dateStr },
    ];

    const rowHeight = 22;
    tableRows.forEach((row, i) => {
      const ry = currentY + i * rowHeight;
      const bg = i % 2 === 0 ? "#F8FAFC" : "#FFFFFF";
      doc.rect(35, ry, contentWidth, rowHeight).fillAndStroke(bg, "#E2E8F0");

      // Right column: Field Label
      doc.font("ArabicBold").fontSize(8.5).fillColor("#334155");
      doc.text(row.field, 35 + contentWidth / 2, ry + 6, {
        width: contentWidth / 2 - 15,
        align: "right",
      });

      // Left column: Value
      doc.font("ArabicRegular").fontSize(8.5).fillColor("#0F172A");
      doc.text(row.value, 45, ry + 6, {
        width: contentWidth / 2 - 20,
        align: "left",
      });
    });

    currentY += tableRows.length * rowHeight + 20;

    // 5. Methodology Note Box
    doc.rect(35, currentY, contentWidth, 50).fillAndStroke("#FEF3C7", "#FDE68A"); // Light amber note

    doc.font("ArabicBold").fontSize(8.5).fillColor("#92400E");
    doc.text(formatArabicRtl("ملاحظة منهجية وإخلاء مسؤولية :"), 45, currentY + 7, {
      width: contentWidth - 20,
      align: "right",
    });

    doc.font("ArabicRegular").fontSize(7.5).fillColor("#78350F");
    const methText = `تم استخراج البيانات من مصدر عام متاح للجمهور بتاريخ ${dateStr}. إجمالي السجلات المستخرجة: 1. ملاحظة: هذه البيانات عامة ومتاحة علنًا، ولا تمثل بالضرورة عينة عشوائية تمثيلية لأغراض التعميم الإحصائي.`;
    doc.text(formatArabicRtl(methText), 45, currentY + 20, {
      width: contentWidth - 20,
      align: "right",
      lineGap: 2,
    });

    // 6. Footer (Pinned strictly inside the single page)
    doc.font("ArabicRegular").fontSize(7.5).fillColor("#94A3B8");
    doc.text(formatArabicRtl("تم استخراج هذا التقرير عبر منصة Diger • جميع الحقوق محفوظة"), 35, 790, {
      width: contentWidth,
      align: "center",
    });

    doc.end();
  });
}

if (require.main === module) {
  const sampleData = {
    metadata: {
      platform: "Diger Data Platform",
      collectedAt: "2026-10-10T08:10:36.747Z",
      jobId: "6ac9f2f600106f35ff46",
    },
    profile: {
      id: "107955",
      uniqueId: "tiktok",
      nickname: "TikTok",
      signature: "Your next discovery is waiting on TikTok.",
      verified: true,
      followerCount: 96149670,
      followingCount: 1,
      heartCount: 465302989,
      videoCount: 1512,
      bioLink: "tiktok.com/discovermore",
    },
  };

  generatePdfReport(sampleData).then((buf) => {
    fs.writeFileSync("test_full_report.pdf", buf);
    console.log("✓ Updated test_full_report.pdf Size:", buf.length);
  });
}
