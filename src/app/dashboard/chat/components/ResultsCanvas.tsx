"use client";

import { useState } from "react";
import type { ReviewSeverity, ReviewSuggestion, ResultReview } from "@/functions/shared/resultReview";
import type { ArtifactEditOperation } from "@/functions/shared/artifactEditing";

export interface ExtractedRecord {
  id: string;
  [key: string]: unknown;
}

interface ResultsCanvasProps {
  records: ExtractedRecord[];
  profile: any;
  jobId: string | null;
  onDownload: (ext: "xlsx" | "pdf" | "csv") => void;
  downloadingKey: string | null;
  onExplainMethodology: () => void;
  onRequestDocxMethodology: () => void;
  onCloseMobile: () => void;
  review?: ResultReview | null;
  reviewSeverity?: ReviewSeverity;
  onKeepResult: () => void;
  onEditAndFetch: () => void;
  onReportMismatch: (category: string, details?: string) => void;
  onReviewSuggestion: (suggestion: ReviewSuggestion) => void;
  currentVersion?: { id: string; versionNum: number } | null;
  versionHistory?: Array<{ id: string; versionNum: number; parentVersionId?: string | null }>;
  artifactHistoryAvailable?: boolean;
  artifactEditing: boolean;
  onArtifactEdit: (operation: ArtifactEditOperation) => void;
  onUndoVersion: (targetVersionId: string) => void;
}

export default function ResultsCanvas({
  records,
  profile,
  jobId,
  onDownload,
  downloadingKey,
  onExplainMethodology,
  onRequestDocxMethodology,
  onCloseMobile,
  review,
  reviewSeverity,
  onKeepResult,
  onEditAndFetch,
  onReportMismatch,
  onReviewSuggestion,
  currentVersion,
  versionHistory = [],
  artifactHistoryAvailable,
  artifactEditing,
  onArtifactEdit,
  onUndoVersion,
}: ResultsCanvasProps) {
  const [tab, setTab] = useState<"table" | "pdf" | "notes" | "files">("table");
  const [searchTerm, setSearchTerm] = useState("");
  const [notesText, setNotesText] = useState("");
  const [complaintOpen, setComplaintOpen] = useState(false);
  const [complaintDetails, setComplaintDetails] = useState("");
  const [renameFrom, setRenameFrom] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [columnOrderText, setColumnOrderText] = useState("");

  const filteredRecords = records.filter((record) =>
    Object.values(record).some((value) => String(value ?? "").toLocaleLowerCase().includes(searchTerm.toLocaleLowerCase()))
  );
  const tableColumns = Array.from(new Set(records.flatMap((record) => Object.keys(record).filter((key) => key !== "id"))));
  const labels: Record<string, string> = {
    username: "اسم المستخدم", displayName: "الاسم التعريفي", followers: "المتابعون",
    following: "المتابعَون", likes: "الإعجابات", videosCount: "المقاطع", verified: "موثّق",
    bio: "النبذة", bioLink: "رابط النبذة", profileUrl: "رابط الملف", collectedDate: "تاريخ الجمع",
    count: "العدد", averageFollowers: "متوسط المتابعين",
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-white border-t border-sand-300 lg:border-t-0 lg:border-r">
      {/* Canvas Top Bar */}
      <div className="p-4 border-b border-sand-200 flex items-center justify-between bg-sand-50">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-ink-900">لوحة النتائج</span>
          {records.length > 0 && (
            <span className="text-2xs px-2 py-0.5 rounded-full bg-sand-200 text-sand-800 font-bold tabular-nums">
              {records.length} سجل
            </span>
          )}
        </div>

        <button
          onClick={onCloseMobile}
          className="p-1.5 text-sand-500 hover:text-ink-900 lg:hidden rounded-lg hover:bg-sand-200"
          aria-label="إغلاق مساحة النتائج"
        >
          ✕
        </button>
      </div>

      {/* Tabs Switcher */}
      <div className="flex border-b border-sand-200 px-4 bg-sand-50/50">
        {[
          { key: "table", label: "البيانات" },
          { key: "pdf", label: "التقرير" },
          { key: "notes", label: "الملاحظات" },
          { key: "files", label: "الملفات" },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as any)}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
              tab === t.key
                ? "border-primary text-ink-900"
                : "border-transparent text-sand-500 hover:text-ink-900"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {jobId && review && (
        <section className="mx-4 mt-4 rounded-xl border border-sand-300 bg-white p-4 space-y-3" aria-label="مراجعة النتيجة" dir="rtl">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-ink-900">مراجعة النتيجة</h2>
            <span className={`rounded-full px-2.5 py-1 text-2xs font-semibold ${reviewSeverity === "critical" ? "bg-red-50 text-red-700" : reviewSeverity === "warning" ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>
              {reviewSeverity === "critical" ? "تحتاج مراجعة" : reviewSeverity === "warning" ? "ملاحظات على التغطية" : "ضمن النطاق المرصود"}
            </span>
          </div>
          <p className="text-xs leading-6 text-sand-700">{review.comparisonAr}</p>
          {review.suggestions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {review.suggestions.slice(0, 3).map((suggestion, index) => (
                <button key={`${suggestion.type}-${index}`} type="button" onClick={() => onReviewSuggestion(suggestion)} className="min-h-11 rounded-lg border border-sand-300 bg-sand-50 px-3 py-2 text-xs font-medium text-ink-800 hover:bg-sand-100 focus-visible:outline-2 focus-visible:outline-primary">
                  {suggestion.labelAr}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button type="button" onClick={onKeepResult} className="min-h-11 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-primary">كمّل بالنتيجة دي</button>
            <button type="button" onClick={onEditAndFetch} className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs font-semibold text-ink-800 hover:bg-sand-50 focus-visible:outline-2 focus-visible:outline-primary">عدّل واسحب تاني</button>
          </div>
          <button type="button" onClick={() => setComplaintOpen((open) => !open)} className="min-h-11 w-full rounded-lg border border-sand-300 bg-sand-50 px-3 py-2 text-xs font-semibold text-ink-800 hover:bg-sand-100 focus-visible:outline-2 focus-visible:outline-primary">مش ده المطلوب؟</button>
          {complaintOpen && (
            <div className="space-y-2 rounded-lg bg-sand-50 p-3" role="group" aria-label="ما المشكلة؟">
              <div className="text-xs font-semibold text-ink-900">ما المشكلة؟</div>
              <div className="flex flex-wrap gap-2">
                {["نوع البيانات", "الفترة", "العدد", "الجودة"].map((category) => (
                  <button key={category} type="button" onClick={() => onReportMismatch(category)} className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs text-ink-800 hover:bg-sand-100 focus-visible:outline-2 focus-visible:outline-primary">{category}</button>
                ))}
              </div>
              <label className="block text-xs font-medium text-sand-700" htmlFor="result-complaint-details">أخرى</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input id="result-complaint-details" value={complaintDetails} maxLength={200} onChange={(event) => setComplaintDetails(event.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg border border-sand-300 bg-white px-3 text-xs text-ink-900 focus-visible:outline-2 focus-visible:outline-primary" placeholder="اكتب ملاحظة قصيرة" />
                <button type="button" disabled={!complaintDetails.trim()} onClick={() => onReportMismatch("أخرى", complaintDetails.trim())} className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs font-semibold text-ink-800 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-primary">إرسال الملاحظة</button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Tab 1: Data Table */}
        {tab === "table" && (
          <div className="space-y-4">
            {jobId && (
              <section className="rounded-xl border border-sand-200 bg-sand-50 p-3 space-y-2" aria-label="تعديلات مجانية على النتيجة" dir="rtl">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-bold text-ink-900">تعديلات على نسخة النتيجة</span>
                  <span className="text-sand-600">{currentVersion ? `نسخة ${currentVersion.versionNum}` : "النسخة الأصلية"} · بدون خصم نقاط</span>
                </div>
                {artifactHistoryAvailable === false && <p className="text-2xs text-amber-800" role="status">سجل النسخ غير متاح حالياً؛ يمكنك تحميل الملفات الأصلية.</p>}
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={artifactEditing || artifactHistoryAvailable === false} onClick={() => onArtifactEdit({ action: "dedupe", keys: ["id", "username", "profileUrl"] })} className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs text-ink-800 disabled:opacity-50">حذف التكرار</button>
                  <button type="button" disabled={artifactEditing || artifactHistoryAvailable === false} onClick={() => onArtifactEdit({ action: "sort", field: "followers", direction: "desc" })} className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs text-ink-800 disabled:opacity-50">ترتيب حسب المتابعين</button>
                  <button type="button" disabled={artifactEditing || artifactHistoryAvailable === false} onClick={() => onArtifactEdit({ action: "select_columns", columns: ["username", "displayName", "followers", "likes"] })} className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs text-ink-800 disabled:opacity-50">الأعمدة الأساسية</button>
                  <button type="button" disabled={artifactEditing || artifactHistoryAvailable === false} onClick={() => onArtifactEdit({ action: "anonymize", fields: ["username", "displayName", "bio", "bioLink", "profileUrl"] })} className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs text-ink-800 disabled:opacity-50">إخفاء المعرّفات</button>
                  <button type="button" disabled={artifactEditing || artifactHistoryAvailable === false} onClick={() => onArtifactEdit({ action: "group_aggregate", groupBy: "verified", metrics: [{ operation: "count", as: "count" }, { field: "followers", operation: "average", as: "averageFollowers" }] })} className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs text-ink-800 disabled:opacity-50">تجميع حسب حالة التوثيق</button>
                  <button type="button" disabled={artifactEditing || artifactHistoryAvailable === false || !searchTerm.trim()} onClick={() => onArtifactEdit({ action: "filter", field: "username", operator: "contains", value: searchTerm.trim() })} className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs text-ink-800 disabled:opacity-50">حفظ البحث كفلتر</button>
                  <button type="button" disabled={artifactEditing || artifactHistoryAvailable === false || !notesText.trim()} onClick={() => onArtifactEdit({ action: "rewrite_summary", summaryAr: notesText.slice(0, 1000) })} className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs text-ink-800 disabled:opacity-50">حفظ الملخص كنسخة</button>
                  <button type="button" disabled={artifactEditing || artifactHistoryAvailable === false} onClick={() => onArtifactEdit({ action: "convert_formats", formats: ["xlsx", "pdf", "csv"] })} className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs text-ink-800 disabled:opacity-50">إعادة توليد الصيغ</button>
                  {(() => {
                    const current = versionHistory.find((version) => version.id === currentVersion?.id);
                    const parentId = current?.parentVersionId || null;
                    return parentId ? <button type="button" disabled={artifactEditing || artifactHistoryAvailable === false} onClick={() => onUndoVersion(parentId)} className="min-h-11 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 disabled:opacity-50">تراجع لنسخة سابقة</button> : null;
                  })()}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <label className="text-2xs text-sand-600">اسم العمود الحالي
                    <input value={renameFrom} onChange={(event) => setRenameFrom(event.target.value)} maxLength={80} className="mt-1 min-h-11 w-full rounded-lg border border-sand-300 bg-white px-3 text-xs text-ink-900 focus-visible:outline-2 focus-visible:outline-primary" />
                  </label>
                  <label className="text-2xs text-sand-600">الاسم الجديد
                    <input value={renameTo} onChange={(event) => setRenameTo(event.target.value)} maxLength={80} className="mt-1 min-h-11 w-full rounded-lg border border-sand-300 bg-white px-3 text-xs text-ink-900 focus-visible:outline-2 focus-visible:outline-primary" />
                  </label>
                  <button type="button" disabled={artifactEditing || artifactHistoryAvailable === false || !renameFrom.trim() || !renameTo.trim()} onClick={() => onArtifactEdit({ action: "rename_columns", renames: { [renameFrom.trim()]: renameTo.trim() } })} className="min-h-11 self-end rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs text-ink-800 disabled:opacity-50">إعادة تسمية العمود</button>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <label className="flex-1 text-2xs text-sand-600">اختيار وترتيب الأعمدة — افصل الأسماء بفواصل
                    <input value={columnOrderText} onChange={(event) => setColumnOrderText(event.target.value)} maxLength={1000} placeholder="username, followers, likes" className="mt-1 min-h-11 w-full rounded-lg border border-sand-300 bg-white px-3 text-xs text-ink-900 focus-visible:outline-2 focus-visible:outline-primary" />
                  </label>
                  <button type="button" disabled={artifactEditing || artifactHistoryAvailable === false || !columnOrderText.trim()} onClick={() => onArtifactEdit({ action: "select_columns", columns: columnOrderText.split(",").map((column) => column.trim()).filter(Boolean).slice(0, 80) })} className="min-h-11 self-end rounded-lg border border-sand-300 bg-white px-3 py-2 text-xs text-ink-800 disabled:opacity-50">تطبيق الأعمدة والترتيب</button>
                </div>
                {artifactEditing && <p className="text-2xs text-sand-600" role="status">جاري إنشاء نسخة جديدة…</p>}
                {versionHistory.length > 0 && <div className="text-2xs text-sand-600">عدد النسخ: {versionHistory.length} من 30</div>}
              </section>
            )}
            <div className="flex items-center justify-between gap-2">
              <input
                type="text"
                placeholder="بحث داخل السجلات المستخرجة..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full px-3 py-1.5 text-xs bg-sand-50 border border-sand-300 rounded-lg focus:outline-hidden focus:border-primary"
              />
            </div>

            {records.length === 0 ? (
              <div className="p-8 text-center text-xs text-sand-500 bg-sand-50/50 rounded-xl border border-dashed border-sand-300">
                {jobId ? "تفاصيل السجلات غير متاحة في لوحة العرض حالياً. راجع تنبيه النتيجة أو حمّل الملفات الأصلية." : "ابدأ الاستخراج لعرض جدول البيانات هنا."}
              </div>
            ) : (
              <div className="border border-sand-200 rounded-xl overflow-hidden shadow-2xs">
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-sand-100 text-sand-700 font-semibold border-b border-sand-200">
                      <tr>{tableColumns.map((column) => <th key={column} className="p-3">{labels[column] || column}</th>)}</tr>
                    </thead>
                    <tbody className="divide-y divide-sand-200">
                      {filteredRecords.map((r, idx) => (
                        <tr key={idx} className="hover:bg-sand-50/60 transition-colors">
                          {tableColumns.map((column) => {
                            const value = r[column];
                            const formatted = typeof value === "number" ? value.toLocaleString("en-US") : typeof value === "boolean" ? (value ? "نعم" : "لا") : value == null || value === "" ? "—" : String(value);
                            return <td key={column} className={`p-3 ${typeof value === "number" ? "tabular-nums" : ""} text-sand-700`} dir={column === "username" ? "ltr" : undefined}>{formatted}</td>;
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: PDF Preview */}
        {tab === "pdf" && (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 bg-sand-50/60 rounded-xl border border-sand-200">
            {jobId ? (
              <div className="w-full space-y-4">
                <div className="p-4 bg-white border border-sand-300 rounded-xl shadow-xs">
                  <div className="text-sm font-bold text-ink-900 mb-1">تقرير نتائج جمع البيانات (PDF)</div>
                  <div className="text-xs text-sand-500 mb-4">
                    متاح للمعاينة والمراجعة والطباعة؛ ويعكس محتوى الملفات المولدة لهذا الطلب.
                  </div>
                  <button
                    onClick={() => onDownload("pdf")}
                    disabled={downloadingKey === "pdf"}
                    className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg shadow-2xs transition-colors cursor-pointer"
                  >
                    {downloadingKey === "pdf" ? "جاري التجهيز..." : "فتح وتحميل تقرير PDF"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-xs text-sand-500">
                يبدأ توليد تقرير PDF بعد اكتمال طلب جمع البيانات.
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Notes */}
        {tab === "notes" && (
          <div className="space-y-3">
            <label className="block text-xs font-semibold text-sand-700">
              ملاحظات البحث والمنهجية الميدانية (قابلة للتحرير):
            </label>
            <textarea
              rows={8}
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
              placeholder="اكتب ملخصًا للنتيجة أو توثيقًا ترغب بحفظه كنسخة جديدة…"
              className="w-full p-3 text-xs bg-white border border-sand-300 rounded-xl focus:outline-hidden focus:border-primary leading-relaxed"
            />
            <div className="text-3xs text-sand-500 text-left">
              هذه الملاحظات مؤقتة على الشاشة ولا تُحفظ أو تُدمج تلقائياً في الملفات.
            </div>
          </div>
        )}

        {/* Tab 4: Downloads */}
        {tab === "files" && (
          <div className="space-y-3">
            <div className="p-3.5 bg-white border border-sand-200 rounded-xl flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-ink-900">ملف Excel كامل (.xlsx)</div>
                <div className="text-3xs text-sand-500">يتضمن جدول البيانات، دليل المتغيرات، وصفحة المنهجية.</div>
              </div>
              <button
                onClick={() => onDownload("xlsx")}
                disabled={downloadingKey === "xlsx" || !jobId}
                className="px-3 py-1.5 bg-sand-100 hover:bg-sand-200 text-ink-800 text-xs font-semibold rounded-lg border border-sand-300 transition-colors disabled:opacity-50 cursor-pointer"
              >
                {downloadingKey === "xlsx" ? "جاري التنزيل..." : "تحميل XLSX"}
              </button>
            </div>

            <div className="p-3.5 bg-white border border-sand-200 rounded-xl flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-ink-900">تقرير ملخص (.pdf)</div>
                <div className="text-3xs text-sand-500">صياغة أنيقة موثقة مع مقاييس التغطية وتفاصيل الحساب.</div>
              </div>
              <button
                onClick={() => onDownload("pdf")}
                disabled={downloadingKey === "pdf" || !jobId}
                className="px-3 py-1.5 bg-sand-100 hover:bg-sand-200 text-ink-800 text-xs font-semibold rounded-lg border border-sand-300 transition-colors disabled:opacity-50 cursor-pointer"
              >
                {downloadingKey === "pdf" ? "جاري التنزيل..." : "تحميل PDF"}
              </button>
            </div>

            <div className="p-3.5 bg-white border border-sand-200 rounded-xl flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-ink-900">بيانات خام (.csv)</div>
                <div className="text-3xs text-sand-500">ملف نصي قياسي بتنسيق UTF-8 للتحليل الإحصائي والبرمجي.</div>
              </div>
              <button
                onClick={() => onDownload("csv")}
                disabled={downloadingKey === "csv" || !jobId}
                className="px-3 py-1.5 bg-sand-100 hover:bg-sand-200 text-ink-800 text-xs font-semibold rounded-lg border border-sand-300 transition-colors disabled:opacity-50 cursor-pointer"
              >
                {downloadingKey === "csv" ? "جاري التنزيل..." : "تحميل CSV"}
              </button>
            </div>
          </div>
        )}

        {/* Methodology On Demand (Section 7) */}
        {jobId && (
          <div className="mt-6 pt-4 border-t border-sand-200 space-y-3">
            <div className="p-3.5 bg-sand-50 border border-sand-200 rounded-xl text-xs space-y-2">
              <div className="font-bold text-ink-900 flex items-center gap-1.5">
                <svg className="w-4 h-4 text-sand-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <span>ملخص حقائق الاستخراج (Methodology Facts):</span>
              </div>
              <div className="space-y-1 text-sand-600 text-2xs">
                <div>• المصدر: بيانات الحساب العامة (@{profile?.username || "tiktok"})</div>
                <div>• تاريخ الجمع: {profile?.collectedDate || records[0]?.extractedAt || "غير متاح"}</div>
                <div>• عدد السجلات المعروضة: {records.length.toLocaleString("ar-EG")}</div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={onExplainMethodology}
                className="w-full py-2 px-3 text-xs font-medium text-ink-800 bg-sand-100 hover:bg-sand-200 border border-sand-300 rounded-xl transition-colors cursor-pointer text-center inline-flex items-center justify-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5 text-sand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <span>اشرح لي كيف تم جمع البيانات</span>
              </button>

              <button
                type="button"
                onClick={onRequestDocxMethodology}
                className="w-full py-2 px-3 text-xs font-semibold text-amber-points hover:text-amber-points-hover bg-amber-points-bg hover:bg-amber-points-bg/80 border border-amber-points/30 rounded-xl transition-colors cursor-pointer text-center flex items-center justify-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5 text-amber-points" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>اكتب المنهجية الرسمية (PDF / Word)</span>
                <span className="text-2xs font-bold">(10 نقاط)</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
