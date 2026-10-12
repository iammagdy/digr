"use client";

import type { ReactNode } from "react";
import { formatAr } from "@/lib/arabicDigits";

/** 0 details · 1 thinking · 2 plan · 3 running · 4 done (a failed run stays at 3) */
export type DocStage = 0 | 1 | 2 | 3 | 4;

interface StepDef {
  n: number;
  title: string;
  doneAt: number;
  curAt: number;
  labels: [string, string, string];
}

const STEPS: StepDef[] = [
  { n: 1, title: "التفاصيل", doneAt: 1, curAt: 0, labels: ["مكتمل", "بانتظارك", ""] },
  { n: 2, title: "الخطة والسعر", doneAt: 3, curAt: 1, labels: ["تمت الموافقة", "بانتظار موافقتك", "لاحقًا"] },
  { n: 3, title: "التنفيذ", doneAt: 4, curAt: 3, labels: ["مكتمل", "جارٍ التنفيذ", "بعد الموافقة"] },
  { n: 4, title: "الملفات", doneAt: 5, curAt: 4, labels: ["", "جاهزة", "عند الاكتمال"] },
];

function Step({ def, stage, last, failed, children }: { def: StepDef; stage: number; last: boolean; failed?: boolean; children?: ReactNode }) {
  const done = stage >= def.doneAt;
  const cur = !done && stage >= def.curAt;
  const ring = failed ? "var(--bad)" : done ? "var(--gold)" : cur ? "var(--ink)" : "var(--ln2)";
  const bg = failed ? "var(--bad)" : done ? "var(--gold)" : "transparent";
  const fg = failed || done ? "#fff" : cur ? "var(--ink)" : "var(--fnt)";
  const status = failed ? "تعذّر الإكمال · استُرد الرصيد" : done ? def.labels[0] : cur ? def.labels[1] : def.labels[2];
  return (
    <section
      className="relative"
      style={{ padding: last ? 0 : "0 0 24px", paddingInlineStart: last ? 36 : 32, opacity: done || cur ? 1 : 0.38, transition: "opacity .6s" }}
      aria-label={def.title}
    >
      <span
        className="absolute right-0 top-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px]"
        style={{ border: `1px solid ${ring}`, background: bg, color: fg }}
      >
        {failed ? "!" : done ? "✓" : formatAr(def.n)}
      </span>
      {!last && <span className="absolute bottom-1.5 right-[11px] top-[30px] w-px bg-ln" />}
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="m-0 text-[13px] font-semibold text-ink">{def.title}</h2>
        <span className="text-xs font-light text-fnt">{status}</span>
      </div>
      {children}
    </section>
  );
}

/** Design «ملف بحث»: one document, four steps. Sections only render their content once reached. */
export default function ResearchDocument({
  dateLabel, question, stage, failed, banner, details, plan, run, files,
}: {
  dateLabel: string;
  question: string;
  stage: DocStage;
  /** The run failed: step 3 turns red and the plan card collapses, as in the design. */
  failed?: boolean;
  banner?: ReactNode;
  details: ReactNode;
  plan: ReactNode;
  run: ReactNode;
  files: ReactNode;
}) {
  const slots = [details, failed ? null : plan, run, files];
  return (
    <article className="mx-auto max-w-[680px]">
      {banner}
      <p className="m-0 text-xs font-light text-fnt">ملف بحث · {dateLabel}</p>
      <h1
        className="mb-0 mt-2.5 font-light leading-[1.6] text-ink"
        style={{ fontSize: "clamp(19px,2.6cqi,23px)", animation: "up .7s both" }}
      >
        {question}
      </h1>
      <div className="mt-6 flex flex-col">
        {STEPS.map((def, i) => (
          <Step key={def.n} def={def} stage={stage} last={i === STEPS.length - 1} failed={failed && def.n === 3}>{slots[i]}</Step>
        ))}
      </div>
    </article>
  );
}
