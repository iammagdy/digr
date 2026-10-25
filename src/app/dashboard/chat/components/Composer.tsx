"use client";

import { useRef, useState, type FormEvent, type ChangeEvent } from "react";

export interface AttachedFile {
  file: File;
  name: string;
  size: number;
  type: "xlsx" | "csv";
  base64: string;
}

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/** Why the paperclip and the send button rest while a reply is on its way (they were dimmed with no word). */
export const ATTACH_WAIT_AR = "الإرفاق والإرسال يعودان عند اكتمال الرد الحالي.";

/** 
 * Mobile-friendly research composer with spreadsheet attachment control.
 * Supports XLSX & CSV exclusion lists with client-side validation and removal.
 */
export default function Composer({
  value,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: (text: string, attachedFile?: AttachedFile | null) => void | boolean | Promise<void | boolean>;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];

    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "xlsx" && ext !== "csv") {
      const isMediaOrDoc = ["pdf", "jpg", "jpeg", "png", "webp", "doc", "docx", "gif"].includes(ext || "");
      if (isMediaOrDoc) {
        setFileError("ملفات بي دي إف والمستندات المصورة غير مدعومة حاليًا. يدعم ديجر ملفات استبعاد بصيغتي إكسل وسي إس في فقط.");
      } else {
        setFileError("صيغة الملف غير مدعومة. يرجى رفع ملف استبعاد بصيغة إكسل أو سي إس في.");
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setFileError("حجم الملف يتجاوز الحد الأقصى المسموح به (٥ ميجابايت).");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        setAttachedFile({
          file,
          name: file.name,
          size: file.size,
          type: ext as "xlsx" | "csv",
          base64: result,
        });
        setFileError(null);
      }
    };
    reader.onerror = () => {
      setFileError("تعذر قراءة محتوى الملف المرفق. يرجى إعادة المحاولة.");
    };
    reader.readAsDataURL(file);
  };

  const removeAttachment = () => {
    setAttachedFile(null);
    setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (disabled || sending) return;
    const trimmed = value.trim();
    if (!trimmed && !attachedFile) return;
    setSending(true);
    try {
      const sent = await onSend(trimmed, attachedFile);
      if (sent === false) return;
      onChange("");
      setAttachedFile(null);
      setFileError(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="shrink-0 px-4 pb-4 pt-2" style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}>
      <div className="mx-auto flex max-w-[720px] flex-col gap-1.5">
        {/* Arabic File Error Notification */}
        {fileError && (
          <div
            role="alert"
            className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50/95 px-3.5 py-2 text-xs font-light text-red-700 shadow-xs"
          >
            <div className="flex items-center gap-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{fileError}</span>
            </div>
            <button
              type="button"
              onClick={() => setFileError(null)}
              className="text-red-500 hover:text-red-700 p-1 cursor-pointer"
              aria-label="إغلاق التنبيه"
            >
              ✕
            </button>
          </div>
        )}

        {/* Selected File Badge */}
        {attachedFile && (
          <div
            className="flex w-fit max-w-full items-center gap-2.5 rounded-full border border-ac/30 bg-ac/5 px-3.5 py-1.5 text-xs text-ink shadow-xs"
            style={{ animation: "up .2s both" }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ac shrink-0" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <span className="truncate font-medium max-w-[220px]" title={attachedFile.name}>
              {attachedFile.name}
            </span>
            <span className="text-[11px] text-mut shrink-0">
              ({Math.round(attachedFile.size / 1024)} ك.ب)
            </span>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-800 font-medium shrink-0">
              ملف استبعاد
            </span>
            <button
              type="button"
              onClick={removeAttachment}
              className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-mut/20 text-mut hover:bg-mut/40 hover:text-ink cursor-pointer text-[10px] after:absolute after:-inset-[14px] after:content-['']"
              aria-label="إزالة الملف المرفق"
              title="إزالة الملف المرفق"
            >
              ✕
            </button>
          </div>
        )}

        {/* Form Container */}
        <form
          onSubmit={submit}
          className="flex w-full items-center gap-1.5 rounded-full border border-ln bg-sf p-1.5"
          style={{ boxShadow: "var(--shadow)" }}
        >
          {/* Hidden File Input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            onChange={handleFileChange}
            className="hidden"
            id="chat-file-attachment"
            aria-label="رفع ملف استبعاد بصيغة إكسل أو سي إس في"
          />

          {/* Attachment Paperclip Button */}
          <button
            type="button"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-[46px] w-[46px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-mut hover:text-ac hover:bg-sf2 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
            aria-label="إرفاق ملف استبعاد بصيغة إكسل أو سي إس في"
            aria-describedby={disabled ? "chat-attach-wait" : undefined}
            title={disabled ? ATTACH_WAIT_AR : "إرفاق ملف استبعاد بصيغة إكسل أو سي إس في"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          {/* Text Input */}
          <input
            ref={inputRef}
            id="chat-composer-input"
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={attachedFile ? "اكتب تفاصيل طلب البحث مع الملف المرفق..." : "اسأل ديجر أو اطلب خطة بحث..."}
            aria-label="اسأل ديجر"
            enterKeyHint="send"
            autoComplete="off"
            maxLength={2000}
            className="min-h-[46px] min-w-0 flex-1 border-0 bg-transparent px-[14px] text-base font-light text-ink outline-none"
          />

          {/* Send Button */}
          <button
            type="submit"
            aria-label="إرسال"
            disabled={disabled || sending || (!value.trim() && !attachedFile)}
            className="flex h-[46px] w-[46px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-ac text-onac disabled:cursor-not-allowed disabled:opacity-60 transition-opacity"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
            </svg>
          </button>
        </form>
        {disabled && (
          <p id="chat-attach-wait" role="status" data-testid="attach-wait" className="m-0 text-center text-[11px] font-light text-mut">{ATTACH_WAIT_AR}</p>
        )}
        <p className="m-0 mt-1 text-center text-[11px] font-light text-mut">
          يدعم إرفاق ملفات الاستبعاد بصيغتي إكسل وسي إس في حتى ٥ ميجابايت. ملفات بي دي إف والمستندات المصورة غير مدعومة حاليًا.
        </p>
      </div>
    </div>
  );
}
