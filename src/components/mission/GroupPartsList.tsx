import Link from "next/link";
import type { JSX } from "react";
import { GROUP_PARTS_TITLE_AR, groupPartLinkAr } from "@/lib/multiProvider/copy";
import { REQUEST_STATUS_LABEL_AR, resolveRequestKind } from "@/lib/jobs/requestStatus";

export interface GroupPartItem {
  index: number;
  jobId: string;
  status: string;
  delivered: number | null;
  requested: number | null;
  charged?: number | null;
}

export interface GroupPartsListProps {
  parts: GroupPartItem[];
  total: number;
  currentJobId: string;
}

export default function GroupPartsList(props: GroupPartsListProps): JSX.Element | null {
  const parts = props.parts ?? [];
  const total = props.total ?? 0;
  if (parts.length < 2 && total < 2) {
    return null;
  }

  return (
    <section data-testid="group-parts" className="flex flex-col gap-3 rounded-[18px] border border-ln bg-sf p-4">
      <h2 className="m-0 font-display text-[16px] font-medium text-ink">{GROUP_PARTS_TITLE_AR}</h2>
      <div className="flex flex-col gap-2">
        {parts.map((p) => {
          const isCurrent = p.jobId === props.currentJobId;
          const kind = resolveRequestKind({
            status: p.status,
            delivered: p.delivered,
            requested: p.requested,
          });
          const stateLabel = REQUEST_STATUS_LABEL_AR[kind];

          return (
            <Link
              key={p.jobId}
              href={`/dashboard/requests/${encodeURIComponent(p.jobId)}`}
              data-testid="group-part-link"
              aria-current={isCurrent ? "page" : undefined}
              className={`flex items-center justify-between gap-3 rounded-[12px] border px-4 py-3 text-sm no-underline transition-colors ${
                isCurrent
                  ? "border-ln2 bg-sf2 font-medium text-ink"
                  : "border-ln bg-sf text-ink hover:border-ln2 hover:bg-sf2"
              }`}
            >
              <span className="font-medium text-ink">{groupPartLinkAr(p.index, total)}</span>
              <span className="rounded-full bg-sf2 px-3 py-0.5 text-[12px] font-medium text-ink">
                {stateLabel}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
