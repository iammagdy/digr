import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

// Helper for Arabic word reversal and punctuation handling for PDFKit
export function formatArabicRtl(text: string): string {
  if (!text) return "";
  const hasArabic = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
  if (!hasArabic) return text;

  // Handle paired parentheses: in RTL visual order, '(' and ')' need to swap
  let normalized = text
    .replace(/\(/g, "TEMP_OPEN")
    .replace(/\)/g, "(")
    .replace(/TEMP_OPEN/g, ")");

  // Handle label : value format where value is English/numbers
  const colonMatch = normalized.match(/^(.*?)\s*:\s*(.*)$/);
  if (colonMatch) {
    const label = colonMatch[1];
    const val = colonMatch[2];
    const valHasArabic = /[\u0600-\u06FF]/.test(val);
    if (!valHasArabic) {
      const revLabel = label.split(" ").reverse().join(" ");
      return `${val} : ${revLabel}`;
    }
  }

  // Tokenize by space, reverse words
  return normalized.split(" ").reverse().join(" ");
}

export function buildSampleProfilePdf(profile: any, metadata: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 28, bottom: 28, left: 35, right: 35 },
      info: {
        Title: `تقرير Diger - ${profile.uniqueId || "tiktok"}`,
        Author: "Diger",
        Subject: "Social Profile Report",
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

    const contentWidth = 525;
    const dateStr = metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);

    // 1. Header Banner
    doc.rect(35, 28, contentWidth, 54).fill("#0F172A");

    doc.font("ArabicBold").fontSize(15).fillColor("#FFFFFF");
    doc.text(formatArabicRtl("منصة Diger لاستخراج البيانات العامة"), 50, 36, {
      width: contentWidth - 30,
      align: "right",
      wordSpacing: 3.5,
    });

    doc.font("ArabicRegular").fontSize(9).fillColor("#94A3B8");
    doc.text(formatArabicRtl(`تقرير ملف تيك توك الشخصي • تاريخ الاستخراج: ${dateStr}`), 50, 58, {
      width: contentWidth - 30,
      align: "right",
      wordSpacing: 3,
    });

    let currentY = 92;

    // 2. Account Profile Overview Card
    doc.rect(35, currentY, contentWidth, 76).fillAndStroke("#F8FAFC", "#CBD5E1");

    doc.font("ArabicBold").fontSize(12).fillColor("#0F172A");
    const headerTitle = `الحساب المستهدف : ${profile.nickname || "—"} (@${profile.uniqueId || "—"})`;
    doc.text(formatArabicRtl(headerTitle), 50, currentY + 10, {
      width: contentWidth - 30,
      align: "right",
      wordSpacing: 3,
    });

    doc.font("ArabicRegular").fontSize(9).fillColor("#334155");
    const bioText = profile.signature ? `النبذة التعريفية : ${profile.signature}` : "النبذة التعريفية : لا توجد نبذة مسجلة";
    doc.text(formatArabicRtl(bioText), 50, currentY + 31, {
      width: contentWidth - 30,
      align: "right",
      wordSpacing: 3,
    });

    const verifiedText = profile.verified ? "موثق رسمياً ✓" : "غير موثق";
    const bioLinkText = profile.bioLink ? profile.bioLink : "لا يوجد رابط خارجي";
    const statusLine = `حالة التوثيق : ${verifiedText}   |   رابط البايو : ${bioLinkText}`;
    doc.text(formatArabicRtl(statusLine), 50, currentY + 52, {
      width: contentWidth - 30,
      align: "right",
      wordSpacing: 3,
    });

    currentY += 86;

    // 3. Key Stat Metric Boxes (4 Columns)
    doc.font("ArabicBold").fontSize(10.5).fillColor("#1E293B");
    doc.text(formatArabicRtl("المؤشرات الرقمية الرئيسية :"), 35, currentY, {
      width: contentWidth,
      align: "right",
      wordSpacing: 3,
    });
    currentY += 16;

    const boxGap = 8;
    const boxWidth = (contentWidth - boxGap * 3) / 4;
    const boxHeight = 54;

    const stats = [
      { label: "المتابعون", val: Number(profile.followerCount || 0).toLocaleString("en-US") },
      { label: "إجمالي الإعجابات", val: Number(profile.heartCount || 0).toLocaleString("en-US") },
      { label: "مقاطع الفيديو", val: Number(profile.videoCount || 0).toLocaleString("en-US") },
      { label: "الحسابات المتابَعة", val: Number(profile.followingCount || 0).toLocaleString("en-US") },
    ];

    stats.forEach((st, idx) => {
      const bx = 35 + idx * (boxWidth + boxGap);
      doc.rect(bx, currentY, boxWidth, boxHeight).fillAndStroke("#FFFFFF", "#CBD5E1");

      doc.font("ArabicRegular").fontSize(8.5).fillColor("#64748B");
      doc.text(formatArabicRtl(st.label), bx, currentY + 9, {
        width: boxWidth,
        align: "center",
        wordSpacing: 3,
      });

      doc.font("ArabicBold").fontSize(12).fillColor("#0F172A");
      doc.text(st.val, bx, currentY + 26, {
        width: boxWidth,
        align: "center",
      });
    });

    currentY += 66;

    // 4. Detailed Data Table
    doc.font("ArabicBold").fontSize(10.5).fillColor("#1E293B");
    doc.text(formatArabicRtl("جدول البيانات التفصيلية :"), 35, currentY, {
      width: contentWidth,
      align: "right",
      wordSpacing: 3,
    });
    currentY += 16;

    const tableRows = [
      { field: "اسم المستخدم", value: `@${profile.uniqueId || "—"}` },
      { field: "الاسم المعروض", value: profile.nickname || "—" },
      { field: "المعرف الرقمي للحساب", value: profile.id || profile.secUid ? profile.id || "مسجل" : "—" },
      { field: "إجمالي عدد المتابعين", value: Number(profile.followerCount || 0).toLocaleString("en-US") },
      { field: "إجمالي عدد الإعجابات", value: Number(profile.heartCount || 0).toLocaleString("en-US") },
      { field: "عدد مقاطع الفيديو المنشورة", value: Number(profile.videoCount || 0).toLocaleString("en-US") },
      { field: "عدد الحسابات المتابَعة", value: Number(profile.followingCount || 0).toLocaleString("en-US") },
      { field: "حالة توثيق الحساب", value: profile.verified ? "موثق رسمياً ✓" : "حساب عادي (غير موثق)" },
      { field: "رابط البايو في الملف", value: profile.bioLink || "لا يوجد رابط" },
      { field: "تاريخ ووقت الاستخراج", value: `${dateStr} (UTC)` },
    ];

    const rowHeight = 21;
    tableRows.forEach((row, i) => {
      const ry = currentY + i * rowHeight;
      const bg = i % 2 === 0 ? "#F8FAFC" : "#FFFFFF";
      doc.rect(35, ry, contentWidth, rowHeight).fillAndStroke(bg, "#E2E8F0");

      // Right column: Field Label
      doc.font("ArabicBold").fontSize(8.5).fillColor("#334155");
      doc.text(formatArabicRtl(row.field), 35 + contentWidth / 2, ry + 5, {
        width: contentWidth / 2 - 15,
        align: "right",
        wordSpacing: 3,
      });

      // Left column: Value
      const valHasArabic = /[\u0600-\u06FF]/.test(row.value);
      doc.font("ArabicRegular").fontSize(8.5).fillColor("#0F172A");
      if (valHasArabic) {
        doc.text(formatArabicRtl(row.value), 45, ry + 5, {
          width: contentWidth / 2 - 20,
          align: "left",
          wordSpacing: 3,
        });
      } else {
        doc.text(row.value, 45, ry + 5, {
          width: contentWidth / 2 - 20,
          align: "left",
        });
      }
    });

    currentY += tableRows.length * rowHeight + 16;

    // 5. Methodology Note Box
    doc.rect(35, currentY, contentWidth, 48).fillAndStroke("#FEF3C7", "#FDE68A");

    doc.font("ArabicBold").fontSize(8.5).fillColor("#92400E");
    doc.text(formatArabicRtl("ملاحظة منهجية وإخلاء مسؤولية :"), 45, currentY + 6, {
      width: contentWidth - 20,
      align: "right",
      wordSpacing: 3,
    });

    doc.font("ArabicRegular").fontSize(7.5).fillColor("#78350F");
    const methText = `تم استخراج البيانات آلياً من مصدر عام ومتاح للجمهور بتاريخ ${dateStr}. إجمالي السجلات: 1. ملاحظة: هذه البيانات عامة ومتاحة علناً، ولا تمثل بالضرورة عينة عشوائية تمثيلية لأغراض التعميم الإحصائي.`;
    doc.text(formatArabicRtl(methText), 45, currentY + 18, {
      width: contentWidth - 20,
      align: "right",
      lineGap: 2,
      wordSpacing: 3,
    });

    // 6. Footer
    doc.font("ArabicRegular").fontSize(7.5).fillColor("#94A3B8");
    doc.text(formatArabicRtl("تم استخراج هذا التقرير عبر منصة Diger • جميع الحقوق محفوظة"), 35, 792, {
      width: contentWidth,
      align: "center",
      wordSpacing: 3,
    });

    doc.end();
  });
}

async function main() {
  const sampleProfile = {
    uniqueId: "iam_megz",
    nickname: "Megz",
    signature: "Digital Creator & Tech Explorer. Welcome to my official profile.",
    verified: false,
    followerCount: 45200,
    followingCount: 142,
    heartCount: 980500,
    videoCount: 88,
    bioLink: "https://bio.link/iam_megz",
  };

  const pdfBuf = await buildSampleProfilePdf(sampleProfile, { collectedAt: "2026-10-10T12:00:00Z" });
  fs.writeFileSync("test_tiktok_clean.pdf", pdfBuf);
  console.log("Generated test_tiktok_clean.pdf (Size:", pdfBuf.length, "bytes)");
}

main().catch(console.error);
