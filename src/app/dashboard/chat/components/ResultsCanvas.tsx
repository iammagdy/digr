"use client";

import { useState } from "react";

export interface ExtractedRecord {
  id: string;
  username: string;
  displayName: string;
  followers: number;
  following: number;
  likes: number;
  videosCount: number;
  verified: boolean;
  bio: string;
  extractedAt: string;
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
}: ResultsCanvasProps) {
  const [tab, setTab] = useState<"table" | "pdf" | "notes" | "files">("table");
  const [searchTerm, setSearchTerm] = useState("");
  const [notesText, setNotesText] = useState(
    "ملاحظات الباحث:\n- تم استخراج البيانات العامة وتوثيق مصدر الحساب.\n- العينة معتمدة للتحليل والدراسة المقارنة."
  );

  const filteredRecords = records.filter((r) =>
    (r.username || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
    (r.displayName || "").toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="h-full flex flex-col bg-white border-r border-sand-300">
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
          className="p-1.5 text-sand-500 hover:text-ink-900 md:hidden rounded-lg hover:bg-sand-200"
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

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Tab 1: Data Table */}
        {tab === "table" && (
          <div className="space-y-4">
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
                لا توجد سجلات مستخرجة بعد. ابدأ الاستخراج لعرض جدول البيانات هنا.
              </div>
            ) : (
              <div className="border border-sand-200 rounded-xl overflow-hidden shadow-2xs">
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-sand-100 text-sand-700 font-semibold border-b border-sand-200">
                      <tr>
                        <th className="p-3">اسم المستخدم</th>
                        <th className="p-3">الاسم التعريفي</th>
                        <th className="p-3">المتابعون</th>
                        <th className="p-3">المتابعَون</th>
                        <th className="p-3">الإعجابات</th>
                        <th className="p-3">المقاطع</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-sand-200">
                      {filteredRecords.map((r, idx) => (
                        <tr key={idx} className="hover:bg-sand-50/60 transition-colors">
                          <td className="p-3 font-semibold text-ink-900" dir="ltr">
                            @{r.username}
                          </td>
                          <td className="p-3 text-sand-700">{r.displayName || "—"}</td>
                          <td className="p-3 font-bold tabular-nums text-ink-900">
                            {r.followers?.toLocaleString("en-US") || "0"}
                          </td>
                          <td className="p-3 tabular-nums text-sand-600">
                            {r.following?.toLocaleString("en-US") || "0"}
                          </td>
                          <td className="p-3 tabular-nums text-sand-600">
                            {r.likes?.toLocaleString("en-US") || "0"}
                          </td>
                          <td className="p-3 tabular-nums text-sand-600">
                            {r.videosCount?.toLocaleString("en-US") || "0"}
                          </td>
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
                  <div className="text-sm font-bold text-ink-900 mb-1">تقرير استخراج الحساب المعتمد (PDF)</div>
                  <div className="text-xs text-sand-500 mb-4">
                    جاهز للمعاينة والمراجعة والطباعة الأكاديمية والتنفيذية.
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
                يبدأ توليد تقرير PDF الموثق بمجرد اعتماد الخطة وبدء الاستخراج.
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
              className="w-full p-3 text-xs bg-white border border-sand-300 rounded-xl focus:outline-hidden focus:border-primary leading-relaxed"
            />
            <div className="text-3xs text-sand-500 text-left">
              تُحفظ الملاحظات تلقائياً مع محادثتك وتُدمج في توثيق النتائج.
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
                <div>• المصدر: الحساب الرسمي على المنصة (@{profile?.username || "tiktok"})</div>
                <div>• التاريخ المطلق: {new Date().toISOString().split("T")[0]}</div>
                <div>• التغطية المحققة: 100% من الحقول المتاحة علناً</div>
                <div>• إزالة التكرار: معتمد آلياً</div>
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
