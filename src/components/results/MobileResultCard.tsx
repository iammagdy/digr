"use client";

import { useState } from "react";
import { toArabicDigits } from "@/lib/arabicDigits";

export interface MobileResultRecord {
  id: string | number;
  title: string;
  subtitle?: string;
  content?: string;
  location?: string;
  verified?: boolean;
  verifiedLabel?: string;
  sourceUrl?: string;
  phone?: string | null;
  email?: string | null;
  publishedAt?: string;
}

export function recordToMobileCard(r: Record<string, unknown>, idx: number): MobileResultRecord {
  const title = String(
    r.name || r.company_name || r.author || r.author_name || r.title || r.full_name || r.username || `نتيجة ${toArabicDigits(idx + 1)}`
  );

  const subtitle = (r.role || r.position || r.headline || r.industry || r.sector || r.category || (r.username && r.username !== title ? `@${String(r.username).replace(/^@/, '')}` : undefined) || r.source_name || undefined) as string | undefined;
  const content = (r.content || r.text || r.body || r.description || r.about || r.bio || r.caption || undefined) as string | undefined;
  const location = (r.location || r.city || r.country || r.address || undefined) as string | undefined;
  const publishedAt = (r.published_at || r.created_at || r.date || undefined) as string | undefined;
  const phone = r.phone !== undefined ? (r.phone ? String(r.phone) : null) : undefined;
  const email = (r.work_email || r.email !== undefined) ? (r.work_email || r.email ? String(r.work_email || r.email) : null) : undefined;
  const sourceUrl = (r.url || r.source_url || r.post_url || r.link || r.website || undefined) as string | undefined;
  const verified = r.verified === true || r.match === true || r.relevant === true;
  const verifiedLabel = (r.verified_label as string | undefined) || (verified ? "مطابق" : undefined);

  return {
    id: (r.id as string | number | undefined) ?? idx,
    title,
    subtitle: subtitle ? String(subtitle) : undefined,
    content: content ? String(content) : undefined,
    location: location ? String(location) : undefined,
    verified,
    verifiedLabel,
    sourceUrl: sourceUrl ? String(sourceUrl) : undefined,
    phone,
    email,
    publishedAt: publishedAt ? String(publishedAt) : undefined,
  };
}

export function MobileResultCard({ record, index }: { record: MobileResultRecord; index: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article
      data-testid={`mobile-result-card-${index}`}
      className="flex flex-col gap-3 rounded-[20px] border border-ln bg-sf p-4 text-start shadow-sm transition-colors hover:border-ln2"
    >
      {/* Header: Title and Status Badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sf2 text-[11px] font-medium text-mut">
              {toArabicDigits(index + 1)}
            </span>
            <h3 className="m-0 text-[16px] font-semibold text-ink leading-snug">
              {record.title}
            </h3>
          </div>
          {record.subtitle && (
            <p className="m-0 text-[13px] font-light text-mut pe-7">
              {record.subtitle}
            </p>
          )}
        </div>

        {record.verifiedLabel && (
          <span
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              record.verified
                ? "bg-[color-mix(in_oklab,var(--ok)_12%,var(--sf))] text-ok"
                : "bg-sf2 text-mut"
            }`}
          >
            {record.verifiedLabel}
          </span>
        )}
      </div>

      {/* Metadata Chips */}
      {(record.location || record.publishedAt) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-mut">
          {record.location && (
            <span className="rounded-md bg-sf2 px-2 py-0.5 text-ink2">
              📍 {record.location}
            </span>
          )}
          {record.publishedAt && (
            <span className="rounded-md bg-sf2 px-2 py-0.5 text-mut">
              🗓️ {toArabicDigits(record.publishedAt)}
            </span>
          )}
        </div>
      )}

      {/* Body Content with Expand/Collapse */}
      {record.content && (
        <div className="flex flex-col gap-1 text-[13px] leading-[1.8] text-ink2">
          <p className={`m-0 ${expanded ? "" : "line-clamp-3"} [text-wrap:pretty]`}>
            {record.content}
          </p>
          {record.content.length > 140 && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="w-fit cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-goldT hover:underline"
            >
              {expanded ? "عرض أقل ↑" : "عرض المزيد ↓"}
            </button>
          )}
        </div>
      )}

      {/* Contact Channels Grid */}
      {(record.phone !== undefined || record.email !== undefined) && (
        <div className="grid grid-cols-1 gap-2 rounded-[14px] bg-sf2/70 p-2.5 text-[12px] sm:grid-cols-2">
          {record.phone !== undefined && (
            <div className="flex items-center justify-between gap-1">
              <span className="text-mut">الهاتف:</span>
              <span dir="ltr" className="font-mono text-ink">
                {record.phone ? toArabicDigits(record.phone) : "غير متاح"}
              </span>
            </div>
          )}
          {record.email !== undefined && (
            <div className="flex items-center justify-between gap-1">
              <span className="text-mut">البريد:</span>
              <span dir="ltr" className="truncate font-mono text-ink max-w-[170px]">
                {record.email || "غير متاح"}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Footer Actions */}
      {record.sourceUrl && (
        <div className="flex items-center justify-end border-t border-ln/60 pt-2.5">
          <a
            href={record.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 items-center gap-1 rounded-full bg-sf2 px-3 text-[12px] font-medium text-ink hover:bg-ln transition-colors no-underline"
          >
            <span>فتح المصدر</span>
            <span aria-hidden="true" dir="ltr">↗</span>
          </a>
        </div>
      )}
    </article>
  );
}

export default MobileResultCard;
