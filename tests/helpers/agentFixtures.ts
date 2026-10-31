import ExcelJS from "exceljs";

/**
 * Fixture files for the invoice agent, built so the TRUE counts are known by construction (the tests assert them; the code must find them).
 * Not every company has two managers, some have none, some have no phone, e-mails repeat or are malformed, phones come in mixed formats.
 */
export interface Fixture { name: string; bytes: Uint8Array; rows: string[][]; expected: { companies: number; managers: number; emails: number; phones: number } }

const FIRST = ["أحمد", "محمد", "محمود", "مصطفى", "منى", "هبة", "سارة", "كريم", "طارق", "ياسر", "نهى", "عمر"];
const LAST = ["حسن", "علي", "إبراهيم", "السيد", "عبد الله", "فتحي", "شاهين", "الجمال", "منصور", "زكي"];
const TOPIC = ["النيل", "الأمل", "الدلتا", "النصر", "الصفوة", "المستقبل", "الهرم", "سيناء", "الوادي", "الشرق"];
const KIND = ["للكهرباء", "للهندسة", "للمقاولات", "للتجارة", "للبترول", "للصناعات"];
const DOMAIN = ["delta-power", "alnile", "nasr-co", "sinai-eng", "valley-trade"];

export const companyName = (prefix: string, i: number): string => `شركة ${TOPIC[i % TOPIC.length]} ${KIND[Math.floor(i / TOPIC.length) % KIND.length]} ${prefix}${i + 1}`;
const manager = (i: number): string => `م. ${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]} ${i + 1}`;
const email = (prefix: string, i: number): string => `user${prefix}${i + 1}@${DOMAIN[i % DOMAIN.length]}.com`;
/** 11-digit Egyptian mobile number number #i (always distinct for different i) */
export const phone11 = (i: number): string => `0${[10, 11, 12, 15][i % 4]}${String(10_000_000 + i * 7919).padStart(8, "0").slice(-8)}`;
/** the same number in a different writing: +20 form, spaced form, or a plain number cell (leading 0 lost) */
export const phoneVariant = (i: number, style: number): string | number => {
  const p = phone11(i);
  if (style === 0) return Number(p); // an Excel number cell: the leading zero is gone
  if (style === 1) return `+20 ${p.slice(1, 3)} ${p.slice(3, 7)} ${p.slice(7)}`;
  if (style === 2) return `${p.slice(0, 4)}-${p.slice(4, 7)}-${p.slice(7)}`;
  return p;
};

interface SheetSpec { name: string; header: string[]; rows: Array<Array<string | number>> }

async function toXlsx(sheets: SheetSpec[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.addRow(s.header);
    for (const r of s.rows) ws.addRow(r);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/**
 * One sector's contact rows. `perCompany[i]` = managers of company i (0, 1 or 2). Email and phone are attached to rows so that exactly
 * `emails` DISTINCT valid addresses and `phones` DISTINCT numbers exist, plus noise: repeated addresses, malformed ones, «-» phones, repeated numbers written differently.
 */
function contactRows(prefix: string, spec: { companies: number; twoManagers: number; oneManager: number; emails: number; phones: number; dupEmails: number; badEmails: number; dupPhones: number; dashPhones: number }) {
  const rows: Array<Array<string | number>> = [];
  const noManager = spec.companies - spec.twoManagers - spec.oneManager;
  let managerNo = 0;
  let emailsLeft = spec.emails, badLeft = spec.badEmails, dupLeft = spec.dupEmails;
  let phonesLeft = spec.phones, dupPhoneLeft = spec.dupPhones, dashLeft = spec.dashPhones;
  let emailNo = 0, phoneNo = 0, n = 0;
  const addRow = (companyIdx: number, hasManager: boolean) => {
    const mgr = hasManager ? manager(managerNo++) : "";
    let mail: string = "";
    // spread the contact data over the rows with a fixed rule (every k-th row), never random
    if (emailsLeft > 0 && n % 4 !== 3) { mail = email(prefix, emailNo++); emailsLeft--; }
    else if (badLeft > 0 && n % 11 === 3) { mail = ["بدون", "abc@", "-", "mail.com", "x@y", "لا يوجد"][badLeft % 6]; badLeft--; }
    else if (dupLeft > 0 && emailNo > 3 && n % 13 === 7) { mail = email(prefix, emailNo - 3).toUpperCase(); dupLeft--; }
    let tel: string | number = "";
    if (phonesLeft > 0 && n % 5 < 2) { tel = phoneVariant(phoneNo, phoneNo % 4); phoneNo++; phonesLeft--; }
    else if (dupPhoneLeft > 0 && phoneNo > 5 && n % 17 === 5) { tel = phoneVariant(phoneNo - 4, (phoneNo + 1) % 4); dupPhoneLeft--; }
    else if (dashLeft > 0 && n % 19 === 9) { tel = "-"; dashLeft--; }
    rows.push([n + 1, companyName(prefix, companyIdx), mgr, mail, tel]);
    n++;
  };
  let c = 0;
  for (let k = 0; k < spec.twoManagers; k++, c++) { addRow(c, true); addRow(c, true); }
  for (let k = 0; k < spec.oneManager; k++, c++) addRow(c, true);
  for (let k = 0; k < noManager; k++, c++) addRow(c, false);
  // any budget left (the fixed rule above may leave some) goes to the rows from the top, so the totals are exact
  let r = 0;
  while (emailsLeft > 0 && r < rows.length) { if (rows[r][3] === "") { rows[r][3] = email(prefix, emailNo++); emailsLeft--; } r++; }
  r = 0;
  while (phonesLeft > 0 && r < rows.length) { if (rows[r][4] === "") { rows[r][4] = phoneVariant(phoneNo, phoneNo % 4); phoneNo++; phonesLeft--; } r++; }
  return rows;
}

const HEADER_A = ["م", "اسم الشركة", "المدير المسؤول", "البريد الإلكتروني", "الهاتف"];

/** كهروميكانيكا: 200 companies, 312 managers (116 with two, 80 with one, 4 with none), 287 distinct valid e-mails, 140 distinct phones */
export async function fixtureElectro(): Promise<Fixture> {
  const rows = contactRows("E", { companies: 200, twoManagers: 116, oneManager: 80, emails: 287, phones: 140, dupEmails: 5, badEmails: 6, dupPhones: 10, dashPhones: 4 });
  return { name: "كهروميكانيكا.xlsx", bytes: await toXlsx([{ name: "الشركات", header: HEADER_A, rows }, { name: "ملاحظات", header: ["ملاحظة"], rows: [["تم السحب يدويًا"], ["مراجعة نهائية"]] }]), rows: [HEADER_A, ...rows.map((r) => r.map(String))], expected: { companies: 200, managers: 312, emails: 287, phones: 140 } };
}

/** بترول: 150 companies, 190 managers (40 with two, 110 with one, 0 with none), 120 e-mails, 95 phones; other header wording */
export async function fixturePetrol(): Promise<Fixture> {
  const rows = contactRows("P", { companies: 150, twoManagers: 40, oneManager: 110, emails: 120, phones: 95, dupEmails: 3, badEmails: 2, dupPhones: 6, dashPhones: 2 });
  const header = ["#", "الشركة", "المدير", "الايميل", "تليفون"];
  return { name: "بترول.xlsx", bytes: await toXlsx([{ name: "بيانات", header, rows }]), rows: [header, ...rows.map((r) => r.map(String))], expected: { companies: 150, managers: 190, emails: 120, phones: 95 } };
}

/** one sheet with a SECTOR column: مقاولات (120 companies) and عقارات (60 companies) mixed row by row */
export async function fixtureMixedSectors(): Promise<Fixture & { bySector: Record<string, { companies: number; managers: number; emails: number; phones: number }> }> {
  const a = contactRows("C", { companies: 120, twoManagers: 20, oneManager: 80, emails: 100, phones: 70, dupEmails: 0, badEmails: 0, dupPhones: 0, dashPhones: 0 });
  const b = contactRows("R", { companies: 60, twoManagers: 5, oneManager: 40, emails: 45, phones: 30, dupEmails: 0, badEmails: 0, dupPhones: 0, dashPhones: 0 });
  const tagged = [...a.map((r) => [...r, "مقاولات"]), ...b.map((r) => [...r, "عقارات"])];
  // interleave so the sector is really read per row, not per block
  const mixed: Array<Array<string | number>> = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (i < a.length) mixed.push(tagged[i]); if (i < b.length) mixed.push(tagged[a.length + i]); }
  const header = ["م", "الشركة", "المسؤول", "e-mail", "رقم الموبايل", "القطاع"];
  return {
    name: "مقاولات وعقارات.xlsx", bytes: await toXlsx([{ name: "الكل", header, rows: mixed }]), rows: [header, ...mixed.map((r) => r.map(String))],
    expected: { companies: 180, managers: 20 * 2 + 80 + 5 * 2 + 40, emails: 145, phones: 100 },
    bySector: { "مقاولات": { companies: 120, managers: 120, emails: 100, phones: 70 }, "عقارات": { companies: 60, managers: 50, emails: 45, phones: 30 } },
  };
}

/** a tiny valid PNG (1x1) and JPEG header for the image path */
export const PNG_1X1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
