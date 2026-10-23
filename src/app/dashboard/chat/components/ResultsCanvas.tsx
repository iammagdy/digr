"use client";

import { useState, useEffect } from "react";
import type { ReviewSeverity, ReviewSuggestion, ResultReview } from "@/functions/shared/resultReview";
import type { ArtifactEditOperation } from "@/functions/shared/artifactEditing";
import { Alert, Badge, Button, EmptyState, Input, Tabs, TextArea, type StatusTone } from "@/components/ui";
import { formatNumber } from "@/lib/honestDisplay";
import { toArabicDigits } from "@/lib/arabicDigits";
import { relativeDateDisplay } from "@/lib/relativeDateDisplay";
import ActivityTerminal, { TerminalEvent } from "./ActivityTerminal";
import { customerResultColumnLabel, previewColumns } from "@/lib/customerResultColumns";
import { producedFormats, type ResultFileIds } from "@/lib/producedFormats";
import { methodologyOffered, METHODOLOGY_POINTS } from "@/lib/methodologyOffer";

export interface ExtractedRecord {
  id: string;
  [key: string]: unknown;
}

interface ResultsCanvasProps {
  records: ExtractedRecord[];
  profile: any;
  jobId: string | null;
  jobStatus?: "queued" | "running" | "done" | "failed" | "cancelled";
  jobEvents?: TerminalEvent[];
  /** Number of events fetched in this read; the activity list says so when a limited history is shown. */
  eventLimit?: number;
  rowsCollected?: number;
  requestedRows?: number;
  reservedPoints?: number;
  chargedPoints?: number;
  duplicatesRemoved?: number;
  errorAr?: string;
  onDownload: (ext: "xlsx" | "pdf" | "csv") => void;
  /** Stored file ids of the finished job; a missing id means that format was not produced. */
  fileIds?: ResultFileIds | null;
  downloadingKey: string | null;
  onExplainMethodology: () => void;
  onRequestDocxMethodology: () => void;
  /** Read from the ledger row `chg_meth_<jobId>`: a bought file shows a download button and never the purchase dialog again. */
  methodologyPurchased?: boolean;
  /** The approved plan, read-only: the «الخطة» tab. */
  planNode?: React.ReactNode;
  onCloseMobile: () => void;
  onClose?: () => void;
  review?: ResultReview | null;
  reviewSeverity?: ReviewSeverity;
  onKeepResult: () => void;
  onEditAndFetch: () => void;
  onReviewSuggestion: (suggestion: ReviewSuggestion) => void;
  currentVersion?: { id: string; versionNum: number } | null;
  versionHistory?: Array<{ id: string; versionNum: number; parentVersionId?: string | null }>;
  artifactHistoryAvailable?: boolean;
  artifactEditing: boolean;
  onArtifactEdit: (operation: ArtifactEditOperation) => void;
  onUndoVersion: (targetVersionId: string) => void;
}

const LEGACY_COLUMN_LABELS: Record<string, string> = {
  username: "اسم المستخدم", displayName: "الاسم التعريفي", followers: "المتابعون",
  following: "المتابعَون", likes: "الإعجابات", videosCount: "المقاطع", verified: "موثّق",
  bio: "النبذة", bioLink: "رابط النبذة", profileUrl: "رابط الملف", collectedDate: "تاريخ الجمع",
  count: "العدد", averageFollowers: "متوسط المتابعين",
  company_name: "اسم الشركة / المؤسسة", contact_name: "اسم المسؤول / جهة الاتصال",
  contact_name_presence_status: "توفر اسم جهة الاتصال",
  job_title: "المسمى الوظيفي", work_email: "البريد الإلكتروني المهني",
  email_verification_status: "توفر البريد", title_verification_status: "توفر المسمى الوظيفي",
  verification_status: "الحالة المسجلة", website: "الموقع الإلكتروني",
  industry: "النشاط / التخصص", activity: "النشاط الرئيسي",
  location: "المدينة / المحافظة", city: "المدينة", phone: "الهاتف التجاري",
  headcount: "حجم العمالة", founded_year: "سنة التأسيس",
  linkedin_url: "رابط لينكد إن", description: "الوصف التعريفي", text: "النص",
  source_id: "معرّف المصدر", extractedAt: "تاريخ الجمع",
};

/** The paid-revision service is not offered: its save is refused, so the controls that call it stay hidden. */
const ARTIFACT_EDIT_TOOLS_AVAILABLE = false;
const RETIRED_SUGGESTION_TYPES = new Set(["dedupe", "change_columns", "anonymize", "export_variant"]);

const SEVERITY_TONE: Record<string, StatusTone> = {
  critical: "danger",
  warning: "warning",
  ok: "success",
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: "تحتاج مراجعة",
  warning: "ملاحظات على التغطية",
  ok: "ضمن النطاق المرصود",
};

const SOURCE_LABELS: Record<string, string> = {
  companies: "قواعد بيانات الشركات والأعمال",
  people: "خدمة البحث عن المهنيين",
  youtube: "يوتيوب",
  facebook: "فيسبوك",
  x: "منصة إكس",
  tiktok: "تيك توك",
  instagram: "إنستغرام",
  linkedin: "لينكد إن",
};

/** A date or a date with a time, as the files keep it (ISO text). The preview shows it in Arabic-Indic digits; the files are not touched. */
const ISO_DATE_TEXT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function formatCell(value: unknown): string {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (value == null || value === "") return "—";
  const text = String(value).replace(/^'+(?=\+?\d)/, "");
  if (ISO_DATE_TEXT.test(text.trim())) return toArabicDigits(text.trim());
  return relativeDateDisplay(text) ?? text;
}

export default function ResultsCanvas({
  records,
  profile,
  jobId,
  jobStatus,
  jobEvents = [],
  eventLimit,
  rowsCollected = 0,
  requestedRows,
  reservedPoints,
  chargedPoints,
  duplicatesRemoved,
  errorAr,
  onDownload,
  fileIds,
  downloadingKey,
  onExplainMethodology,
  onRequestDocxMethodology,
  methodologyPurchased = false,
  planNode,
  onCloseMobile,
  onClose,
  review,
  reviewSeverity,
  onKeepResult,
  onEditAndFetch,
  onReviewSuggestion,
  currentVersion,
  versionHistory = [],
  artifactHistoryAvailable,
  artifactEditing,
  onArtifactEdit,
  onUndoVersion,
}: ResultsCanvasProps) {
  const [tab, setTab] = useState<"terminal" | "table" | "pdf" | "notes" | "files" | "plan">(
    jobStatus === "running" || jobStatus === "queued" || records.length === 0 ? "terminal" : "table"
  );

  useEffect(() => {
    if (jobStatus === "running" || jobStatus === "queued") {
      setTab("terminal");
    } else if (jobStatus === "done" && records.length > 0) {
      setTab((prev) => (prev === "terminal" ? "table" : prev));
    }
  }, [jobStatus, records.length]);
  const [searchTerm, setSearchTerm] = useState("");
  const [notesText, setNotesText] = useState("");
  const [renameFrom, setRenameFrom] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [columnOrderText, setColumnOrderText] = useState("");

  const filteredRecords = records.filter((record) =>
    Object.values(record).some((value) => String(value ?? "").toLocaleLowerCase().includes(searchTerm.toLocaleLowerCase()))
  );
  const isCompanyDataset = records.some((record) => record.company_name);
  const COMPANY_PREFERRED = [
    "company_name",
    "industry",
    "city",
    "address",
    "website",
    "linkedin_url",
    "phone",
    "work_email",
  ];

  const hasDescription = records.some(
    (record) => record.description !== undefined && record.description !== null && record.description !== ""
  );
  const hasCity = records.some(
    (record) => record.city !== undefined && record.city !== null && record.city !== ""
  );

  const rawColumns = Array.from(
    new Set(
      records.flatMap((record) =>
        Object.keys(record).filter(
          (key) => key !== "id" && !key.startsWith("_") && !key.endsWith("_relevance_status")
        )
      )
    )
  );

  let candidateColumns = rawColumns;
  if (hasDescription) {
    candidateColumns = candidateColumns.filter((key) => key !== "text");
  }
  if (hasCity) {
    candidateColumns = candidateColumns.filter((key) => key !== "location");
  }

  let orderedColumns: string[] = [];
  if (isCompanyDataset) {
    for (const key of COMPANY_PREFERRED) {
      if (candidateColumns.includes(key)) {
        orderedColumns.push(key);
      }
    }
    for (const key of candidateColumns) {
      if (!orderedColumns.includes(key)) {
        orderedColumns.push(key);
      }
    }
  } else {
    orderedColumns = candidateColumns;
  }

  const tableColumns = previewColumns(orderedColumns, isCompanyDataset).filter((key, index, shown) => {
    const label = LEGACY_COLUMN_LABELS[key] || customerResultColumnLabel(key);
    return (
      shown.findIndex(
        (candidate) => (LEGACY_COLUMN_LABELS[candidate] || customerResultColumnLabel(candidate)) === label
      ) === index
    );
  });
  // A failed request that delivered no record has no file to offer.
  const deliveredCount = records.length > 0 ? records.length : rowsCollected ?? 0;
  const nothingDelivered = jobStatus === "failed" && deliveredCount === 0;
  const editDisabled = artifactEditing || artifactHistoryAvailable === false;
  const visibleSuggestions = (review?.suggestions ?? []).filter((suggestion) => !RETIRED_SUGGESTION_TYPES.has(suggestion.type));

  const quickEdits: Array<{ label: string; op: ArtifactEditOperation; needsSearch?: boolean; needsNotes?: boolean }> = [
    { label: "حذف التكرار", op: { action: "dedupe", keys: ["id", "username", "profileUrl"] } },
    { label: "ترتيب حسب المتابعين", op: { action: "sort", field: "followers", direction: "desc" } },
    { label: "الأعمدة الأساسية", op: { action: "select_columns", columns: ["username", "displayName", "followers", "likes"] } },
    { label: "إخفاء المعرّفات", op: { action: "anonymize", fields: ["username", "displayName", "bio", "bioLink", "profileUrl"] } },
    { label: "تجميع حسب التوثيق", op: { action: "group_aggregate", groupBy: "verified", metrics: [{ operation: "count", as: "count" }, { field: "followers", operation: "average", as: "averageFollowers" }] } },
    { label: "حفظ البحث كفلتر", op: { action: "filter", field: "username", operator: "contains", value: searchTerm.trim() }, needsSearch: true },
    { label: "حفظ الملخص كنسخة", op: { action: "rewrite_summary", summaryAr: notesText.slice(0, 1000) }, needsNotes: true },
    { label: "إعادة توليد الصيغ", op: { action: "convert_formats", formats: ["xlsx", "pdf", "csv"] } },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-sf">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-sand-200 bg-sand-50/70 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-bold text-ink-900">لوحة النتائج</h2>
          {records.length > 0 && (
            <span className="tnum rounded-full bg-ac px-2.5 py-0.5 text-xs font-semibold text-onac">
              {formatNumber(records.length)} سجل
            </span>
          )}
          {currentVersion && (
            <span className="tnum rounded-full bg-sand-200 px-2 py-0.5 text-xs font-semibold text-sand-700">
              نسخة {formatNumber(currentVersion.versionNum)}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose || onCloseMobile}
          aria-label="إغلاق لوحة النتائج"
          className="touch-target inline-flex items-center justify-center rounded-xl text-sand-500 hover:bg-sand-200 hover:text-ink-900"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div className="border-b border-sand-200 bg-sf px-3">
        <Tabs
          tabs={[
            { id: "terminal" as const, label: "سجل النشاط" },
            { id: "table" as const, label: "البيانات" },
            // The report tab exists only when this request produced a PDF.
            ...(!nothingDelivered && producedFormats(fileIds).includes("pdf") ? [{ id: "pdf" as const, label: "التقرير" }] : []),
            { id: "notes" as const, label: "الملاحظات" },
            { id: "files" as const, label: "الملفات" },
            ...(planNode ? [{ id: "plan" as const, label: "الخطة" }] : []),
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>

      {/* Result review */}
      {jobId && review && (
        <section className="border-b border-sand-200 bg-sand-50/60 p-4" aria-label="مراجعة النتيجة">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-ink-900">مراجعة النتيجة</h3>
            <Badge tone={SEVERITY_TONE[reviewSeverity ?? "ok"] ?? "neutral"}>
              {SEVERITY_LABEL[reviewSeverity ?? "ok"] ?? reviewSeverity}
            </Badge>
          </div>
          <p className="text-xs leading-6 text-sand-700">{review.comparisonAr}</p>
          {visibleSuggestions.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {visibleSuggestions.slice(0, 3).map((suggestion, index) => (
                <button
                  key={`${suggestion.type}-${index}`}
                  type="button"
                  onClick={() => onReviewSuggestion(suggestion)}
                  className="min-h-11 cursor-pointer rounded-xl border border-sand-300 bg-sf px-3 py-2 text-xs font-semibold text-ink-800 transition-colors hover:border-gold hover:bg-accent-light/40"
                >
                  {suggestion.labelAr}
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button size="sm" onClick={onKeepResult}>كمّل بالنتيجة دي</Button>
            <Button size="sm" variant="secondary" onClick={onEditAndFetch}>عدّل واسحب تاني</Button>
          </div>
        </section>
      )}

      {tab === "terminal" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ActivityTerminal
            status={jobStatus || (jobId ? "running" : "queued")}
            events={jobEvents}
            rowsCollected={records.length > 0 ? records.length : rowsCollected}
            requestedRows={requestedRows}
            reservedPoints={reservedPoints}
            chargedPoints={chargedPoints}
            duplicatesRemoved={duplicatesRemoved}
            errorAr={errorAr}
            onDownload={onDownload}
            fileIds={fileIds}
            eventLimit={eventLimit}
          />
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "plan" && planNode}
        {tab === "table" && (
          <div className="space-y-4">
            {/* Quick artifact edits: hidden while the paid-revision service is not offered (the save is refused). */}
            {ARTIFACT_EDIT_TOOLS_AVAILABLE && jobId && (
              <details className="group rounded-[20px] border border-sand-200 bg-sand-50/60">
                <summary className="min-h-11 cursor-pointer list-none px-4 py-3 text-xs font-bold text-ink-900 [&::-webkit-details-marker]:hidden">
                  <span className="inline-flex items-center gap-2">
                    <svg className="h-4 w-4 text-accent transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                    أدوات تنقيح البيانات
                  </span>
                </summary>
                <div className="space-y-3 border-t border-sand-200 p-4">
                  <div className="flex flex-wrap gap-2">
                    {quickEdits.map((q) => (
                      <button
                        key={q.label}
                        type="button"
                        disabled={editDisabled || (q.needsSearch && !searchTerm.trim()) || (q.needsNotes && !notesText.trim())}
                        onClick={() => onArtifactEdit(q.op)}
                        className="min-h-11 cursor-pointer rounded-xl border border-sand-300 bg-sf px-3 py-2 text-xs font-semibold text-ink-800 transition-colors hover:border-gold disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {q.label}
                      </button>
                    ))}
                    {(() => {
                      const current = versionHistory.find((v) => v.id === currentVersion?.id);
                      const parentId = current?.parentVersionId;
                      return parentId ? (
                        <button type="button" disabled={editDisabled} onClick={() => onUndoVersion(parentId)} className="min-h-11 cursor-pointer rounded-xl border border-amber-points/40 bg-amber-points-bg px-3 py-2 text-xs font-bold text-amber-points transition-colors hover:bg-amber-points-bg/70 disabled:cursor-not-allowed disabled:opacity-50">
                          التراجع لنسخة سابقة
                        </button>
                      ) : null;
                    })()}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex items-end gap-2">
                      <div className="flex-1 space-y-1">
                        <label className="text-xs font-semibold text-sand-700" htmlFor="rc-rename-from">إعادة تسمية عمود</label>
                        <Input id="rc-rename-from" value={renameFrom} onChange={(e) => setRenameFrom(e.target.value)} maxLength={80} placeholder="الاسم الحالي" />
                      </div>
                      <Input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} maxLength={80} placeholder="الاسم الجديد" aria-label="الاسم الجديد للعمود" className="flex-1" />
                      <Button size="sm" variant="secondary" disabled={editDisabled || !renameFrom.trim() || !renameTo.trim()} onClick={() => onArtifactEdit({ action: "rename_columns", renames: { [renameFrom.trim()]: renameTo.trim() } })}>
                        تطبيق
                      </Button>
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="flex-1 space-y-1">
                        <label className="text-xs font-semibold text-sand-700" htmlFor="rc-col-order">ترتيب الأعمدة (افصل بفاصلة)</label>
                        <Input id="rc-col-order" value={columnOrderText} onChange={(e) => setColumnOrderText(e.target.value)} maxLength={1000} placeholder="username, followers, likes" dir="ltr" className="text-left" />
                      </div>
                      <Button size="sm" variant="secondary" disabled={editDisabled || !columnOrderText.trim()} onClick={() => onArtifactEdit({ action: "select_columns", columns: columnOrderText.split(",").map((c) => c.trim()).filter(Boolean).slice(0, 80) })}>
                        تطبيق
                      </Button>
                    </div>
                  </div>
                  {artifactEditing && <p className="text-xs text-sand-600" role="status">جاري إنشاء نسخة جديدة…</p>}
                  {versionHistory.length > 0 && <p className="tnum text-xs text-sand-500">عدد النسخ: {formatNumber(versionHistory.length)} من {formatNumber(30)}</p>}
                </div>
              </details>
            )}

            <Input
              type="search"
              placeholder="بحث داخل السجلات..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              aria-label="بحث داخل السجلات"
            />

            {records.length === 0 ? (
              <EmptyState
                title={jobId ? "تفاصيل السجلات غير متاحة هنا" : "لا توجد بيانات بعد"}
                description={jobId ? "راجع تنبيه النتيجة أعلاه أو حمّل الملفات الأصلية من تبويب الملفات." : "ابدأ استخراجًا لعرض جدول البيانات هنا."}
              />
            ) : (
              <div className="overflow-hidden rounded-[20px] border border-sand-200">
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="border-b border-sand-200 bg-sand-100/80">
                        {tableColumns.map((column) => (
                          <th key={column} scope="col" className="whitespace-nowrap px-3 py-2.5 font-bold text-sand-700">{LEGACY_COLUMN_LABELS[column] || customerResultColumnLabel(column)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-sand-100 bg-sf">
                      {filteredRecords.map((r, idx) => (
                        <tr key={String(r.id ?? idx)} className="transition-colors hover:bg-sand-50/70">
                          {tableColumns.map((column) => {
                            const value = column === "headcount" && Number(r[column]) === 0 ? "غير متاح" : r[column];
                            return (
                              <td key={column} dir={column === "username" ? "ltr" : undefined} className={`min-w-28 max-w-64 whitespace-normal break-words px-3 py-2.5 align-top leading-6 ${typeof value === "number" ? "tnum" : ""} text-sand-700`}>
                                {formatCell(value)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="tnum border-t border-sand-100 bg-sand-50/60 px-3 py-2 text-xs text-sand-500">
                  عرض {formatNumber(filteredRecords.length)} من أصل {formatNumber(records.length)} سجل
                </p>
              </div>
            )}
          </div>
        )}

        {tab === "pdf" && (
          <div className="flex h-full flex-col items-center justify-center rounded-[20px] border border-dashed border-sand-300 bg-sand-50/60 p-8 text-center">
            {jobId ? (
              <div className="w-full max-w-sm space-y-4">
                <span aria-hidden="true" className="mx-auto flex h-14 w-14 items-center justify-center rounded-[20px] bg-sf text-danger shadow-xs ring-1 ring-sand-200">
                  <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}><path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                </span>
                <div>
                  <h3 className="text-sm font-bold text-ink-900">تقرير نتائج جمع البيانات (بي دي إف)</h3>
                  <p className="mt-1 text-xs leading-relaxed text-sand-600">يعكس محتوى الملفات المولّدة لهذا الطلب — متاح للمعاينة والطباعة.</p>
                </div>
                <Button onClick={() => onDownload("pdf")} disabled={downloadingKey === "pdf"} className="w-full">
                  {downloadingKey === "pdf" ? "جاري التجهيز..." : "فتح وتحميل تقرير بي دي إف"}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-sand-500">يبدأ توليد تقرير بي دي إف بعد اكتمال طلب جمع البيانات.</p>
            )}
          </div>
        )}

        {tab === "notes" && (
          <div className="space-y-3">
            <label className="block text-xs font-bold text-ink-900" htmlFor="rc-notes">
              ملاحظات البحث والمنهجية — قابلة للتحرير
            </label>
            <TextArea
              id="rc-notes"
              rows={8}
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
              placeholder="اكتب ملخصًا للنتيجة أو توثيقًا ترغب بحفظه كنسخة جديدة…"
              className="min-h-44 leading-relaxed"
            />
            <p className="text-xs text-sand-500">هذه الملاحظات مؤقتة على الشاشة — استخدم «حفظ الملخص كنسخة» من أدوات التنقيح لحفظها.</p>
          </div>
        )}

        {tab === "files" && (
          <div className="space-y-3">
            {nothingDelivered && <p className="text-xs leading-6 text-sand-600" role="status">لا توجد ملفات لهذا الطلب لأنه لم يُسلّم أي سجل، ولم يُخصم منك أي رصيد.</p>}
            {(nothingDelivered ? [] : [
              { ext: "xlsx" as const, label: "إكسل", title: "ملف إكسل", desc: "جدول البيانات فقط." },
              { ext: "pdf" as const, label: "بي دي إف", title: "الدليل المنهجي", desc: "منهجية الجمع وحدود البيانات." },
              { ext: "csv" as const, label: "سي إس في", title: "بيانات جدولية", desc: "للاستخدام في التحليل." },
            ]).filter((f) => producedFormats(fileIds).includes(f.ext)).map((f) => (
              <div key={f.ext} className="flex items-center justify-between gap-3 rounded-[20px] border border-sand-200 bg-sf p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span aria-hidden="true" className="tnum flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ac text-xs font-semibold text-onac">{f.label}</span>
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-ink-900">{f.title}</p>
                    <p className="mt-0.5 text-xs text-sand-500">{f.desc}</p>
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => onDownload(f.ext)} disabled={downloadingKey === f.ext || !jobId}>
                  {downloadingKey === f.ext ? `جاري تنزيل ${f.label}...` : `تحميل ${f.label}`}
                </Button>
              </div>
            ))}
            {jobId && methodologyOffered({ status: jobStatus, delivered: deliveredCount }) && (
              <div className="flex items-center justify-between gap-3 rounded-[20px] border border-sand-200 bg-sf p-4" data-testid="methodology-offer">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-ink-900">المنهجية الرسمية</p>
                  <p className="mt-0.5 text-xs text-sand-500">ملف بي دي إف يوثّق طريقة جمع البيانات وحدودها.</p>
                </div>
                <Button size="sm" variant="secondary" onClick={onRequestDocxMethodology} className="tnum shrink-0">
                  {methodologyPurchased ? "تحميل المنهجية" : `اكتب المنهجية الرسمية (${formatNumber(METHODOLOGY_POINTS)} نقاط)`}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Methodology facts */}
        {jobId && tab === "pdf" && (
          <div className="mt-6 space-y-3 border-t border-sand-200 pt-4">
            <div className="rounded-[20px] border border-sand-200 bg-sand-50/70 p-4 text-xs">
              <p className="mb-2 font-bold text-ink-900">حقائق الاستخراج والمنهجية</p>
              <dl className="space-y-1.5 text-sand-600">
                <div className="flex justify-between gap-2">
                  <dt>المصدر</dt>
                  <dd className="font-semibold text-ink-800" dir="auto">
                    {profile?.sourcePlatform ? (SOURCE_LABELS[String(profile.sourcePlatform).toLowerCase()] || String(profile.sourcePlatform)) : profile?.username ? `حساب @${profile.username}` : "غير متاح"}
                  </dd>
                </div>
                <div className="flex justify-between gap-2"><dt>تاريخ الجمع</dt><dd className="font-semibold text-ink-800">{profile?.collectedDate || (records[0]?.extractedAt as string) || "غير متاح"}</dd></div>
                <div className="flex justify-between gap-2"><dt>السجلات المعروضة</dt><dd className="tnum font-semibold text-ink-800">{formatNumber(records.length)}</dd></div>
              </dl>
            </div>
            <div className="grid gap-2">
              <Button size="sm" variant="secondary" onClick={onExplainMethodology} className="w-full">
                اشرح لي كيف تم جمع البيانات
              </Button>
              {methodologyOffered({ status: jobStatus, delivered: deliveredCount }) && (
                <Button size="sm" variant="secondary" onClick={onRequestDocxMethodology} className="tnum w-full">
                  {methodologyPurchased ? "تحميل المنهجية" : `اكتب المنهجية الرسمية (${formatNumber(METHODOLOGY_POINTS)} نقاط)`}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
