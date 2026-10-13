import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import * as path from "path";
import * as fs from "fs";
import { fontRegularBase64, fontBoldBase64 } from "./embeddedFonts";

let cachedRegularBuffer: Buffer | null = null;
let cachedBoldBuffer: Buffer | null = null;

function getRegularFontBuffer(): Buffer {
  if (!cachedRegularBuffer) {
    const diskPath = path.join(__dirname, "..", "..", "assets", "fonts", "IBMPlexSansArabic-Regular.ttf");
    if (fs.existsSync(diskPath)) {
      cachedRegularBuffer = fs.readFileSync(diskPath);
    } else {
      cachedRegularBuffer = Buffer.from(fontRegularBase64, "base64");
    }
  }
  return cachedRegularBuffer;
}

function getBoldFontBuffer(): Buffer {
  if (!cachedBoldBuffer) {
    const diskPath = path.join(__dirname, "..", "..", "assets", "fonts", "IBMPlexSansArabic-Bold.ttf");
    if (fs.existsSync(diskPath)) {
      cachedBoldBuffer = fs.readFileSync(diskPath);
    } else {
      cachedBoldBuffer = Buffer.from(fontBoldBase64, "base64");
    }
  }
  return cachedBoldBuffer;
}

/**
 * BiDi-aware line builder for PDFKit:
 * Reorders Arabic words for visual RTL rendering while preserving LTR values (English text, URLs, numbers).
 * Swaps paired punctuation (parentheses, brackets) so they wrap Arabic tokens correctly.
 */
export function formatArabicRtl(text: string): string {
  if (!text) return "";

  // If text contains no Arabic characters, keep it as-is
  const hasArabic = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
  if (!hasArabic) return text;

  // Protect ASCII parenthesized tokens like (@iam_megz) or (UTC) or (123)
  const asciiParenTokens: string[] = [];
  let protectedText = text.replace(/\([a-zA-Z0-9_@.\s-]+\)/g, (match) => {
    asciiParenTokens.push(match);
    return `\u0000ASCII_PAREN_${asciiParenTokens.length - 1}\u0000`;
  });

  // Swap remaining Arabic paired punctuation: '(' becomes ')' and ')' becomes '('
  protectedText = protectedText
    .replace(/\(/g, "\u0000OPEN\u0000")
    .replace(/\)/g, "(")
    .replace(/\u0000OPEN\u0000/g, ")")
    .replace(/\[/g, "\u0000B_OPEN\u0000")
    .replace(/\]/g, "[")
    .replace(/\u0000B_OPEN\u0000/g, "]");

  // Restore ASCII parenthesized tokens
  protectedText = protectedText.replace(/\u0000ASCII_PAREN_(\d+)\u0000/g, (_, idx) => {
    return asciiParenTokens[parseInt(idx, 10)];
  });

  // If it's a label + value like: "الحساب المستهدف : MeGz (@iam_megz)"
  const colonMatch = protectedText.match(/^(.*?)\s*:\s*(.*)$/);
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
  return protectedText.split(" ").reverse().join(" ");
}

/**
 * Generate a white-label Excel (.xlsx) file with:
 * - Sheet 1: Clean data with Arabic column headers + methodology note
 * - Sheet 2: Codebook with field names, Arabic descriptions, and types
 */
export async function generateExcelReport(payload: any): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  wb.title = "Diger Data Platform Export";

  const profile = payload.profile || {};
  const metadata = payload.metadata || {};
  const dateStr = metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);

  // ================= Sheet 1: Data =================
  const wsData = wb.addWorksheet("البيانات", { views: [{ rightToLeft: true }] });

  // Title Banner Rows
  const titleRow = wsData.addRow(["منصة Diger لاستخراج البيانات العامة"]);
  titleRow.font = { name: "Arial", size: 14, bold: true, color: { argb: "FF0F172A" } };

  const totalRowsCount = payload.rows?.length || (payload.profile ? 1 : 0);
  const methText = `ملاحظة منهجية: تم جمع هذه البيانات من مصادر عامة ومتاحة علنًا بتاريخ ${dateStr}. إجمالي السجلات: ${totalRowsCount}. ملاحظة: هذه البيانات عامة ومتاحة علنًا، ولا تمثل بالضرورة عينة عشوائية تمثيلية لأغراض التعميم الإحصائي.`;
  const methRow = wsData.addRow([methText]);
  methRow.font = { name: "Arial", size: 9.5, italic: true, color: { argb: "FF475569" } };

  wsData.addRow([]); // Blank line

  if (payload.rows && Array.isArray(payload.rows) && payload.rows.length > 0) {
    // Arbitrary tabular rows support
    const rawKeys = Object.keys(payload.rows[0]);
    const headerRow = wsData.addRow(rawKeys);
    headerRow.font = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
    headerRow.alignment = { horizontal: "center", vertical: "middle" };
    headerRow.height = 28;

    for (const r of payload.rows) {
      const rowVals = rawKeys.map((k) => (typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k] ?? ""));
      const addedRow = wsData.addRow(rowVals);
      addedRow.font = { name: "Arial", size: 10 };
      addedRow.alignment = { vertical: "middle" };
      addedRow.height = 22;
    }

    wsData.columns = rawKeys.map(() => ({ width: 22 }));
  } else {
    // Column Headers for TikTok profile
    const headerValues = [
      "معرف الحساب",
      "اسم المستخدم",
      "الاسم الظاهر",
      "النبذة التعريفية",
      "حساب موثق",
      "إجمالي المتابعين",
      "الحسابات المتابَعة",
      "إجمالي الإعجابات",
      "عدد مقاطع الفيديو",
      "رابط البايو",
      "تاريخ الجمع",
    ];

    const headerRow = wsData.addRow(headerValues);
    headerRow.font = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E293B" }, // Dark slate
    };
    headerRow.alignment = { horizontal: "center", vertical: "middle" };
    headerRow.height = 28;

    // Data Row
    const dataValues = [
      profile.id || "",
      `@${profile.uniqueId || ""}`,
      profile.nickname || "",
      profile.signature || "",
      profile.verified ? "نعم" : "لا",
      Number(profile.followerCount || 0),
      Number(profile.followingCount || 0),
      Number(profile.heartCount || 0),
      Number(profile.videoCount || 0),
      profile.bioLink || "",
      dateStr,
    ];

    const dataRow = wsData.addRow(dataValues);
    dataRow.font = { name: "Arial", size: 10.5 };
    dataRow.alignment = { vertical: "middle" };
    dataRow.height = 24;

    // Format numbers with comma separator
    dataRow.getCell(6).numFmt = "#,##0";
    dataRow.getCell(7).numFmt = "#,##0";
    dataRow.getCell(8).numFmt = "#,##0";
    dataRow.getCell(9).numFmt = "#,##0";

    // Auto-fit column widths
    wsData.columns = [
      { width: 16 }, // ID
      { width: 18 }, // Username
      { width: 22 }, // Nickname
      { width: 45 }, // Signature
      { width: 14 }, // Verified
      { width: 18 }, // Followers
      { width: 18 }, // Following
      { width: 20 }, // Likes
      { width: 18 }, // Videos
      { width: 30 }, // Bio Link
      { width: 15 }, // Date
    ];
  }

  // ================= Sheet 2: Codebook =================
  const wsCode = wb.addWorksheet("دليل البيانات", { views: [{ rightToLeft: true }] });

  const codeTitle = wsCode.addRow(["دليل حقول ومصطلحات البيانات (Data Codebook)"]);
  codeTitle.font = { name: "Arial", size: 13, bold: true, color: { argb: "FF0F172A" } };
  wsCode.addRow([]);

  const codeHeader = wsCode.addRow(["اسم الحقل (Field)", "الوصف باللغة العربية (Description)", "نوع البيانات (Type)"]);
  codeHeader.font = { name: "Arial", size: 10.5, bold: true, color: { argb: "FFFFFFFF" } };
  codeHeader.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF334155" },
  };
  codeHeader.alignment = { horizontal: "center", vertical: "middle" };
  codeHeader.height = 25;

  const codeRows = [
    ["id", "المعرف الرقمي الفريد للحساب على المنصة", "نص (String)"],
    ["uniqueId", "اسم المستخدم الرسمي الفريد (Handle)", "نص (String)"],
    ["nickname", "الاسم المعروض الظاهر للمستخدم في الملف الشخصي", "نص (String)"],
    ["signature", "النبذة التعريفية وسيرة الحساب المسجلة (Bio)", "نص (String)"],
    ["verified", "حالة توثيق الحساب بالعلامة الرسمية (نعم / لا)", "منطقي (Boolean)"],
    ["followerCount", "إجمالي عدد المتابعين للحساب", "رقم صحيح (Integer)"],
    ["followingCount", "إجمالي عدد الحسابات التي يتابعها هذا الحساب", "رقم صحيح (Integer)"],
    ["heartCount", "إجمالي عدد الإعجابات التي حصلت عليها جميع مقاطع الحساب", "رقم صحيح (Integer)"],
    ["videoCount", "إجمالي عدد مقاطع الفيديو المنشورة في الحساب", "رقم صحيح (Integer)"],
    ["bioLink", "الرابط الإلكتروني الخارجي المضاف في ملف الحساب إن وجد", "نص (String)"],
    ["collectedAt", "تاريخ وتوقيت إتمام عملية استخراج البيانات", "تاريخ (Date)"],
  ];

  codeRows.forEach((r, idx) => {
    const row = wsCode.addRow(r);
    row.font = { name: "Arial", size: 10 };
    row.height = 20;
    if (idx % 2 === 1) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
  });

  wsCode.columns = [
    { width: 22 },
    { width: 55 },
    { width: 20 },
  ];

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Generate a white-label 1-page PDF report in Arabic RTL with embedded IBM Plex Sans Arabic font
 */
export function generatePdfReport(payload: any): Promise<Buffer> {
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

    doc.registerFont("ArabicRegular", getRegularFontBuffer());
    doc.registerFont("ArabicBold", getBoldFontBuffer());

    const buffers: Buffer[] = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const contentWidth = 525; // A4 width (595.28) minus margins (35 * 2)
    const profile = payload.profile || {};
    const metadata = payload.metadata || {};
    const dateStr = metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const isTabular = Boolean(payload.rows && Array.isArray(payload.rows) && !payload.profile);
    const titleText = isTabular ? (payload.metadata?.title || "تقرير استخراج البيانات") : "منصة Diger لاستخراج البيانات العامة";
    const subTitleText = isTabular
      ? `إجمالي السجلات: ${payload.rows.length} • تاريخ الاستخراج: ${dateStr}`
      : `تقرير ملف تيك توك الشخصي • تاريخ الاستخراج: ${dateStr}`;

    // 1. Header Banner
    doc.rect(35, 28, contentWidth, 54).fill("#0F172A"); // Dark slate

    doc.font("ArabicBold").fontSize(15).fillColor("#FFFFFF");
    doc.text(formatArabicRtl(titleText), 50, 36, {
      width: contentWidth - 30,
      align: "right",
      wordSpacing: 3.5,
    });

    doc.font("ArabicRegular").fontSize(9).fillColor("#94A3B8");
    doc.text(formatArabicRtl(subTitleText), 50, 58, {
      width: contentWidth - 30,
      align: "right",
      wordSpacing: 3,
    });

    let currentY = 92;

    if (isTabular) {
      // Tabular multi-record layout
      doc.rect(35, currentY, contentWidth, 50).fillAndStroke("#F8FAFC", "#E2E8F0");
      doc.font("ArabicBold").fontSize(11).fillColor("#0F172A");
      doc.text(formatArabicRtl(`ملخص استخراج البيانات (${payload.rows.length} سجل)`), 50, currentY + 10, {
        width: contentWidth - 30,
        align: "right",
        wordSpacing: 3,
      });
      doc.font("ArabicRegular").fontSize(9).fillColor("#475569");
      doc.text(formatArabicRtl(`تمت معالجة وحفظ البيانات بصيغ Excel و CSV و PDF مع إتاحة التحميل المباشر.`), 50, currentY + 28, {
        width: contentWidth - 30,
        align: "right",
        wordSpacing: 3,
      });

      currentY += 65;

      // Table preview (first 10 records)
      doc.font("ArabicBold").fontSize(10).fillColor("#1E293B");
      doc.text(formatArabicRtl("عينة من السجلات المستخرجة :"), 35, currentY, {
        width: contentWidth,
        align: "right",
        wordSpacing: 3,
      });
      currentY += 16;

      const sampleRows = payload.rows.slice(0, 10);
      const rowHeight = 22;
      sampleRows.forEach((r: any, idx: number) => {
        const ry = currentY + idx * rowHeight;
        const bg = idx % 2 === 0 ? "#F8FAFC" : "#FFFFFF";
        doc.rect(35, ry, contentWidth, rowHeight).fillAndStroke(bg, "#E2E8F0");

        const previewText = r.title || r.text || r.username || r.id || `السجل #${idx + 1}`;
        doc.font("ArabicRegular").fontSize(8).fillColor("#0F172A");
        doc.text(formatArabicRtl(String(previewText).slice(0, 60)), 45, ry + 6, {
          width: contentWidth - 20,
          align: "right",
          wordSpacing: 2.5,
        });
      });

      currentY += sampleRows.length * rowHeight + 20;

      // Methodology Note
      doc.rect(35, currentY, contentWidth, 48).fillAndStroke("#FEF3C7", "#FDE68A");
      doc.font("ArabicBold").fontSize(8.5).fillColor("#92400E");
      doc.text(formatArabicRtl("ملاحظة منهجية :"), 45, currentY + 6, {
        width: contentWidth - 20,
        align: "right",
        wordSpacing: 3,
      });
      doc.font("ArabicRegular").fontSize(7.5).fillColor("#78350F");
      doc.text(formatArabicRtl(metadata.methodology || `تم استخراج ${payload.rows.length} سجل بنجاح.`), 45, currentY + 18, {
        width: contentWidth - 30,
        align: "right",
        wordSpacing: 3,
      });

      // Footer
      doc.font("ArabicRegular").fontSize(7.5).fillColor("#94A3B8");
      doc.text(formatArabicRtl("تم استخراج هذا التقرير عبر منصة Diger • جميع الحقوق محفوظة"), 35, 792, {
        width: contentWidth,
        align: "center",
        wordSpacing: 3,
      });

      doc.end();
      return;
    }

    // 2. Account Profile Overview Card
    doc.rect(35, currentY, contentWidth, 76).fillAndStroke("#F8FAFC", "#CBD5E1");

    doc.font("ArabicBold").fontSize(12).fillColor("#0F172A");
    const profileHandleText = `الحساب المستهدف : ${profile.nickname || "—"} (@${profile.uniqueId || "—"})`;
    doc.text(formatArabicRtl(profileHandleText), 50, currentY + 10, {
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

    // 3. Key Metric Stat Boxes (4 Columns)
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
      { field: "المعرف الرقمي للحساب", value: profile.id || profile.secUid ? String(profile.id || profile.secUid) : "—" },
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
    doc.rect(35, currentY, contentWidth, 48).fillAndStroke("#FEF3C7", "#FDE68A"); // Light amber note

    doc.font("ArabicBold").fontSize(8.5).fillColor("#92400E");
    doc.text(formatArabicRtl("ملاحظة منهجية وإخلاء مسؤولية :"), 45, currentY + 6, {
      width: contentWidth - 20,
      align: "right",
      wordSpacing: 3,
    });

    doc.font("ArabicRegular").fontSize(7.5).fillColor("#78350F");
    const line1 = `تم استخراج هذه البيانات آلياً من المصدر الرسمي العام بتاريخ ${dateStr} (إجمالي السجلات: 1).`;
    const line2 = "ملاحظة: هذه البيانات عامة ومتاحة علناً، ولا تمثل بالضرورة عينة تمثيلية لأغراض التعميم الإحصائي.";
    doc.text(formatArabicRtl(line1), 50, currentY + 18, {
      width: contentWidth - 40,
      align: "right",
      wordSpacing: 2.5,
    });
    doc.text(formatArabicRtl(line2), 50, currentY + 31, {
      width: contentWidth - 40,
      align: "right",
      wordSpacing: 2.5,
    });

    // 6. Footer (Strictly single page)
    doc.font("ArabicRegular").fontSize(7.5).fillColor("#94A3B8");
    doc.text(formatArabicRtl("تم استخراج هذا التقرير عبر منصة Diger • جميع الحقوق محفوظة"), 35, 792, {
      width: contentWidth,
      align: "center",
      wordSpacing: 3,
    });

    doc.end();
  });
}

/**
 * Generate a white-label CSV file with UTF-8 BOM for clean Arabic support in Excel
 */
export function generateCsvReport(payload: any): Buffer {
  const profile = payload.profile || {};
  const metadata = payload.metadata || {};
  const dateStr = metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);

  const escapeCsv = (val: any) => {
    const s = String(val ?? "").replace(/"/g, '""');
    return `"${s}"`;
  };

  if (payload.rows && Array.isArray(payload.rows) && payload.rows.length > 0) {
    const rawKeys = Object.keys(payload.rows[0]);
    const headerLine = rawKeys.map(escapeCsv).join(",");
    const rowLines = payload.rows.map((row: any) => {
      return rawKeys.map((k) => escapeCsv(typeof row[k] === "object" ? JSON.stringify(row[k]) : row[k] ?? "")).join(",");
    });
    const csvContent = "\uFEFF" + headerLine + "\n" + rowLines.join("\n") + "\n";
    return Buffer.from(csvContent, "utf-8");
  }

  const headers = [
    "معرف الحساب",
    "اسم المستخدم",
    "الاسم الظاهر",
    "النبذة التعريفية",
    "حساب موثق",
    "إجمالي المتابعين",
    "الحسابات المتابَعة",
    "إجمالي الإعجابات",
    "عدد مقاطع الفيديو",
    "رابط البايو",
    "تاريخ الجمع",
  ];

  const values = [
    escapeCsv(profile.id || ""),
    escapeCsv(`@${profile.uniqueId || ""}`),
    escapeCsv(profile.nickname || ""),
    escapeCsv(profile.signature || ""),
    escapeCsv(profile.verified ? "نعم" : "لا"),
    profile.followerCount || 0,
    profile.followingCount || 0,
    profile.heartCount || 0,
    profile.videoCount || 0,
    escapeCsv(profile.bioLink || ""),
    escapeCsv(dateStr),
  ];

  // UTF-8 BOM (\uFEFF) ensures Excel opens Arabic characters flawlessly
  const csvContent = "\uFEFF" + headers.join(",") + "\n" + values.join(",") + "\n";
  return Buffer.from(csvContent, "utf-8");
}
