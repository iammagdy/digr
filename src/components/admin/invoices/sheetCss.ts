/**
 * The CSS of the printed sheet, as a string (rendered in one <style>), so the sheet looks the same in the admin preview, in the print dialog (Save as PDF)
 * and in the PNG capture. A4 pages are REAL fixed-size elements (210 x 297 mm): "page X of Y" is exact everywhere and does not depend on CSS page counters.
 * Arabic shaping and right-to-left order are done by the browser's own text engine; numbers are Arabic-Indic strings produced by the code, isolated left-to-right.
 */
export const SHEET_PAGE_WIDTH_PX = 794;
export const SHEET_PAGE_HEIGHT_PX = 1123;

export const SHEET_CSS = `
@page { size: A4; margin: 0; }
.inv-pages { display: flex; flex-direction: column; gap: 16px; align-items: flex-start; }
.inv-page, .inv-page * { box-sizing: border-box; }
.inv-page {
  position: relative; width: 210mm; height: 297mm; flex: none; overflow: hidden; background: #ffffff; color: #111827; direction: rtl; text-align: right;
  font-family: var(--font-vazirmatn), "Vazirmatn", "Noto Naskh Arabic", "Segoe UI", Tahoma, sans-serif; font-size: 12px; line-height: 1.7;
  padding: 11mm 13mm 9mm; display: flex; flex-direction: column; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  box-shadow: 0 1px 3px rgba(0,0,0,.18);
}
.inv-page .num { direction: ltr; unicode-bidi: isolate; display: inline-flex; flex-direction: row; white-space: nowrap; vertical-align: baseline; }
.inv-page .ltr { direction: ltr; unicode-bidi: isolate; display: inline-block; overflow-wrap: anywhere; text-align: left; }
.inv-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 8px; border-bottom: 2px solid #111827; height: 54px; flex: none; }
.inv-head img { height: 34px; width: auto; display: block; }
.inv-head .title { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; }
.inv-badge { display: inline-block; padding: 0 9px; border-radius: 999px; border: 1px solid #6b7280; color: #374151; font-size: 11px; font-weight: 600; line-height: 20px; }
.inv-badge.void { border-color: #b91c1c; color: #b91c1c; }
.inv-badge.paid { border-color: #047857; color: #047857; }
.inv-body { flex: 1; min-height: 0; overflow: hidden; padding-top: 10px; }
.inv-first { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding-bottom: 12px; }
.inv-first.solo { grid-template-columns: 1fr; }
.inv-box { border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 11px; }
.inv-box h3 { margin: 0 0 4px; font-size: 11px; font-weight: 600; color: #6b7280; }
.inv-kv { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; font-size: 12px; }
.inv-kv dt { color: #6b7280; margin: 0; }
.inv-kv dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.inv-seller-name { font-weight: 700; font-size: 14px; margin-bottom: 2px; }
.inv-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
.inv-table th { background: #f3f4f6; font-weight: 600; font-size: 11px; padding: 5px 6px; border-top: 1px solid #9ca3af; border-bottom: 1px solid #9ca3af; text-align: right; vertical-align: bottom; }
.inv-table td { padding: 4px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; overflow-wrap: anywhere; }
.inv-table .m { text-align: left; }
.inv-table th.m { text-align: left; }
.inv-table tr.heading td { background: #f9fafb; font-weight: 700; border-bottom: 1px solid #d1d5db; padding-top: 7px; }
.inv-table tr.subtotal td, .inv-table tr.batchSummary td { font-weight: 700; background: #f9fafb; }
.inv-table tr.aggregate td { color: #374151; font-style: normal; }
.inv-table.c2 { font-size: 11px; } .inv-table.c3 { font-size: 10px; }
.inv-tail { padding-top: 12px; }
.inv-sum { width: 62%; margin-inline-start: auto; border-collapse: collapse; font-size: 12px; margin-bottom: 8px; }
.inv-sum th { text-align: left; font-size: 11px; color: #6b7280; font-weight: 600; padding: 2px 6px; }
.inv-sum td { padding: 3px 6px; border-bottom: 1px solid #e5e7eb; }
.inv-sum td.m { text-align: left; }
.inv-sum tr.strong td { font-weight: 700; font-size: 14px; border-top: 2px solid #111827; border-bottom: 0; padding-top: 6px; }
.inv-sum .caption { font-weight: 700; padding-bottom: 3px; }
.inv-note { font-size: 11px; color: #4b5563; margin: 2px 0; }
.inv-pay { display: flex; gap: 14px; align-items: flex-start; }
.inv-pay .txt { flex: 1; white-space: pre-wrap; overflow-wrap: anywhere; }
.inv-pay h4 { margin: 0 0 3px; font-size: 11px; color: #6b7280; font-weight: 600; }
.inv-pay img { width: 96px; height: 96px; object-fit: contain; border: 1px solid #d1d5db; border-radius: 4px; flex: none; }
.inv-foot { flex: none; display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid #d1d5db; padding-top: 5px; font-size: 10.5px; color: #6b7280; height: 24px; }
.inv-watermark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; font-size: 130px; font-weight: 800; transform: rotate(-24deg); color: rgba(17,24,39,.06); }
.inv-watermark.void { color: rgba(185,28,28,.09); }
.inv-measure-host { position: fixed; top: 0; left: 0; width: 210mm; height: 297mm; overflow: hidden; visibility: hidden; pointer-events: none; z-index: -1; }
.inv-print-root { display: none; }
@media print {
  body > *:not(.inv-print-root) { display: none !important; }
  .inv-print-root { display: block !important; }
  .inv-print-root .inv-pages { display: block; gap: 0; }
  .inv-print-root .inv-page { box-shadow: none; break-after: page; page-break-after: always; margin: 0; }
  .inv-print-root .inv-page:last-child { break-after: auto; page-break-after: auto; }
  html, body { background: #ffffff !important; margin: 0 !important; padding: 0 !important; }
}
`;
