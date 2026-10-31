import ExcelJS from "exceljs";

/**
 * SYNTHETIC files that reproduce the SHAPES of the owner's real files (the real files hold personal data and are never used or committed).
 *
 * Shape (both families): row 1 = a title MERGED across the table, row 2 = the headers, data from row 3. A company row has «م» and the company name; the rows below it with
 * an empty company cell are MORE MANAGERS of the same company. Cells may hold several values separated by « / » (phones with «(Ext. 142)»).
 *
 *  - ELECTROMECHANICAL: 4 files x 50 companies, 601 managers (0 to 6 per company), each manager with a name, a title and an e-mail; only the third file has manager phones.
 *    Truth: 200 distinct companies, 601 managers, 0 departments.
 *  - PETROLEUM: ONE file, 3 sheets. The first is the OVERALL list (150 company rows = 149 companies, one of them listed twice); the other two are DETAIL breakdowns of the same
 *    companies (35 + 115 rows) that repeat the same contacts. 271 distinct contact rows = 239 people + 32 departments («إدارة المشتريات والعقود», «قطاع …», «Procurement Department»).
 *    Truth: 149 distinct companies, 239 people, 32 departments; 300 company rows in all, so 151 repeats.
 */
export interface ShapeFile { name: string; bytes: Uint8Array }

const FIRST = ["أحمد", "محمد", "محمود", "مصطفى", "منى", "هبة", "سارة", "كريم", "طارق", "ياسر", "نهى", "عمر"];
const LAST = ["حسن", "علي", "إبراهيم", "السيد", "عبد الله", "فتحي", "شاهين", "الجمال", "منصور", "زكي"];
const TOPIC = ["النيل", "الأمل", "الدلتا", "النصر", "الصفوة", "المستقبل", "الهرم", "سيناء", "الوادي", "الشرق"];
const KIND = ["للكهرباء", "للهندسة", "للمقاولات", "للتجارة", "للصناعات", "للتوريدات"];
const TITLES = ["مدير عام", "مدير المشتريات", "رئيس مجلس الإدارة", "مدير المشروعات", "العضو المنتدب", "مدير العقود"];
const DEPARTMENTS = ["إدارة المشتريات والعقود", "قطاع المشتريات وسلاسل الإمداد", "الإدارة العامة للمشتريات", "قسم التوريدات", "Procurement Department", "Department of Contracts", "إدارة العقود", "قطاع التعاقدات"];

interface Contact { name: string; title: string; email: string; phone: string }
const person = (n: number): string => `م. ${FIRST[n % FIRST.length]} ${LAST[Math.floor(n / FIRST.length) % LAST.length]} ${n + 1}`;
const phone = (n: number): string => `010${String(10_000_000 + n * 7919).slice(-8)}`;

async function toXlsx(sheets: Array<{ name: string; title: string; header: string[]; rows: Array<Array<string | number>>; mergeCompanyCol?: number }>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.addRow([s.title, ...Array(s.header.length - 1).fill("")]);
    ws.mergeCells(1, 1, 1, s.header.length); // the title spans the table: every cell of row 1 then reads as the same text
    ws.addRow(s.header);
    for (const r of s.rows) ws.addRow(r);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** rows of one company block: the first contact shares the company row, the others are continuation rows (company cell empty) */
function block(no: number, company: Array<string | number>, contacts: Contact[], contactCells: (c: Contact) => Array<string | number>, emptyContact: Array<string | number>): Array<Array<string | number>> {
  if (!contacts.length) return [[no, ...company, ...emptyContact]];
  return contacts.map((c, i) => (i === 0 ? [no, ...company, ...contactCells(c)] : ["", ...company.map(() => ""), ...contactCells(c)]));
}

// ---------------------------------------------------------------- electromechanical

/** managers per company for one file: a fixed 0-to-5 pattern, topped up to the file's exact total */
function managerCounts(total: number): number[] {
  const pattern = [4, 3, 2, 5, 0, 3, 4, 2, 3, 3];
  const counts = Array.from({ length: 50 }, (_, j) => pattern[j % 10]);
  let sum = counts.reduce((a, b) => a + b, 0), k = 0;
  while (sum < total) { counts[k % 50] += 1; sum += 1; k += 7; }
  return counts;
}

export const ELECTRO_TRUTH = { files: 4, companies: 200, managers: 601, departments: 0 } as const;
export const ELECTRO_PER_FILE_MANAGERS = [150, 151, 150, 150] as const;
export const ELECTRO_MAPPING = { company: "B", manager: "E", email: "G", phone: "D" } as const;

export async function electroShapeFiles(): Promise<ShapeFile[]> {
  const out: ShapeFile[] = [];
  let managerNo = 0;
  for (let f = 0; f < 4; f++) {
    const withPhones = f === 2; // only ONE file has manager phones
    const header = ["م", "اسم الشركة", "البريد العام للشركة", "هاتف الشركة", "اسم المدير", "المسمى الوظيفي", "البريد الإلكتروني للمدير", ...(withPhones ? ["هاتف المدير"] : [])];
    const counts = managerCounts(ELECTRO_PER_FILE_MANAGERS[f]);
    const rows: Array<Array<string | number>> = [];
    counts.forEach((n, j) => {
      const idx = f * 50 + j;
      const company = [`شركة ${TOPIC[idx % TOPIC.length]} ${KIND[Math.floor(idx / TOPIC.length) % KIND.length]} ${idx + 1}`, idx % 3 === 0 ? `info@co${idx}.com / sales@co${idx}.com` : `info@co${idx}.com`, `02${String(2_000_000 + idx).slice(-7)} / ${phone(idx)} (Ext. ${100 + (idx % 90)})`];
      const contacts: Contact[] = Array.from({ length: n }, () => { const m = managerNo++; return { name: person(m), title: TITLES[m % TITLES.length], email: `m${m}@co${idx}.com`, phone: phone(m + 5000) }; });
      rows.push(...block(j + 1, company, contacts, (c) => [c.name, c.title, c.email, ...(withPhones ? [c.phone] : [])], ["", "", "", ...(withPhones ? [""] : [])]));
    });
    out.push({ name: `كهروميكانيكا ${f + 1}.xlsx`, bytes: await toXlsx([{ name: "Sheet1", title: `دليل شركات الكهروميكانيكا — الجزء ${f + 1}`, header, rows }]) });
  }
  return out;
}

// ---------------------------------------------------------------- petroleum

export const PETRO_TRUTH = { companies: 149, people: 239, departments: 32, companyRows: 300, repeats: 151 } as const;
export const PETRO_SHEETS = { overall: "دليل شركات البترول (150 شركة)", drilling: "شركات الحفر والخدمات (35)", authority: "شركات الهيئة والمشترك (115)" } as const;
export const PETRO_MAPPING = { company: "B", company_en: "C", manager: "D", email: "F", phone: "G" } as const;
export const PETRO_FILE = "البترول.xlsx";

interface PetroCompany { ar: string; en: string; contacts: Contact[] }

function petroCompanies(): PetroCompany[] {
  // 149 companies, 271 contacts in all (0 to 4 each), 32 of them departments
  const pattern = [2, 1, 3, 2, 1, 2, 0, 3, 2, 1];
  const counts = Array.from({ length: 149 }, (_, i) => pattern[i % 10]);
  let sum = counts.reduce((a, b) => a + b, 0), k = 1;
  while (sum < 271) { counts[k % 149] += 1; sum += 1; k += 11; }
  let contactNo = 0, personNo = 0, deptNo = 0;
  return counts.map((n, i) => ({
    ar: `شركة ${TOPIC[i % TOPIC.length]} ${["للبترول", "للغاز", "للحفر", "للخدمات البترولية"][Math.floor(i / TOPIC.length) % 4]} ${i + 1}`,
    en: `${["Nile", "Hope", "Delta", "Victory", "Elite", "Future", "Pyramid", "Sinai", "Valley", "East"][i % 10]} Petroleum Co ${i + 1}`,
    contacts: Array.from({ length: n }, () => {
      const idx = contactNo++;
      const isDept = Math.floor((idx + 1) * 32 / 271) > Math.floor(idx * 32 / 271);
      if (isDept) { const d = deptNo++; return { name: DEPARTMENTS[d % DEPARTMENTS.length], title: "", email: `dept${d}@petro${i}.com`, phone: `02${String(5_000_000 + d).slice(-7)} (Ext. ${100 + (d % 90)})` }; }
      const p = personNo++;
      return { name: person(p + 800), title: TITLES[p % TITLES.length], email: `p${p}@petro${i}.com / alt${p}@petro${i}.com`, phone: `${phone(p + 9000)} / 02${String(6_000_000 + p).slice(-7)}` };
    }),
  }));
}

export async function petroShapeFile(): Promise<ShapeFile> {
  const companies = petroCompanies();
  // the OVERALL sheet: the 149 companies and the first one's neighbour listed a second time (150 company rows, one repeated)
  const overall: PetroCompany[] = [...companies, companies[9]];
  const header = ["م", "اسم الشركة", "Company Name", "اسم جهة الاتصال", "المسمى الوظيفي", "البريد الإلكتروني", "الهاتف"];
  const rowsOf = (list: PetroCompany[]) => list.flatMap((c, i) => block(i + 1, [c.ar, c.en], c.contacts, (x) => [x.name, x.title, x.email, x.phone], ["", "", "", ""]));
  return {
    name: PETRO_FILE,
    bytes: await toXlsx([
      { name: PETRO_SHEETS.overall, title: "دليل شركات البترول", header, rows: rowsOf(overall) },
      { name: PETRO_SHEETS.drilling, title: "شركات الحفر والخدمات", header, rows: rowsOf(overall.slice(0, 35)) },
      { name: PETRO_SHEETS.authority, title: "شركات الهيئة والمشترك", header, rows: rowsOf(overall.slice(35)) },
    ]),
  };
}
