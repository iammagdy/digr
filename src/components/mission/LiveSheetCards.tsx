"use client";

import type { LiveData, LiveWindow } from "@/lib/agentMission/stage2/livePoller";
import type { LiveCell, LiveRow } from "@/lib/agentMission/stage2/liveSheet";
import { cellTextOf, LIVE_PAGE_ROWS, LiveProgressBar, LiveSheetTabs, liveTitleOf, nextOffsetOf, pageLineAr, prevOffsetOf } from "./LiveSheetGrid";

/**
 * STAGE 2 S10 (docs/STAGE-2.md): THE LIVE SHEET ON A PHONE (narrower than 640 px): the counter «X من N» on top (the file's own numbers), then one card per row with its first three filled
 * cells under their headers, and «عرض المزيد» for the next window. Draws only what the route sent.
 *
 * LAUNCH ROUND: nothing of a row is out of reach: under its three first fields each card opens «كل الحقول» (every other filled field of the file's row, and its identifiers, under the
 * file's own headers); the sheets of the file have tabs here too; the counter has its bar when the promised total is known; long words and links wrap (no sideways scroll at 320 px).
 */
export const LIVE_COUNTER_TITLE_AR = "المجموع حتى الآن";
export const LIVE_FINAL_COUNTER_TITLE_AR = "المجموع النهائي";
export const LIVE_MORE_AR = "عرض المزيد";
export const LIVE_BACK_AR = "عرض السابق";
export const LIVE_ALL_FIELDS_AR = "كل الحقول";
const CARD_CELLS = 3;
/** The file's own row number is not one of the fields a card leads with (it stays in «كل الحقول»). */
const ROW_NUMBER_HEADER = "م";

interface Field { h: string; c: LiveCell }
/** Every field of a row as the file has it: its filled cells under their headers (`file`), then «المعرّف» and «معرّف الأصل», the file's last columns (`ids`). */
export function fieldsOf(row: LiveRow, headers: ReadonlyArray<string>): { file: Field[]; ids: Field[] } {
  const file: Field[] = [];
  row.cells.forEach((c, i) => { const h = headers[i]; if (h && c.k !== "empty") file.push({ h, c }); });
  const ids: Field[] = [];
  const idHeader = headers[row.cells.length];
  if (idHeader && row.id) ids.push({ h: idHeader, c: { k: "text", v: row.id } });
  const parentHeader = headers[row.cells.length + 1];
  if (parentHeader && row.parentId) ids.push({ h: parentHeader, c: { k: "text", v: row.parentId } });
  return { file, ids };
}
/** The fields a card leads with (the first three filled cells of the file's columns, the row number aside) and the rest, in the file's order (nothing is left out). */
export function cardFieldsOf(row: LiveRow, headers: ReadonlyArray<string>): { lead: Field[]; rest: Field[] } {
  const { file, ids } = fieldsOf(row, headers);
  const lead = file.filter((f) => f.h !== ROW_NUMBER_HEADER).slice(0, CARD_CELLS);
  return { lead, rest: [...file.filter((f) => !lead.includes(f)), ...ids] };
}

const Value = ({ c }: { c: LiveCell }) => (c.k === "link" ? <a href={c.v} target="_blank" rel="noopener noreferrer" className="text-ac underline [overflow-wrap:anywhere]">{c.v}</a> : <>{cellTextOf(c)}</>);

function FieldList({ fields, testId }: { fields: Field[]; testId?: string }) {
  return (
    <dl className="m-0 flex flex-col gap-1" data-testid={testId}>
      {fields.map(({ c, h }, i) => (
        <div key={`${h}-${i}`} className="flex min-w-0 flex-col">
          <dt className="text-[12px] text-ink2">{h}</dt>
          <dd className="m-0 min-w-0 text-[14px] text-ink [overflow-wrap:anywhere]"><Value c={c} /></dd>
        </div>
      ))}
    </dl>
  );
}

export function LiveSheetCards({ data, onWindow = () => undefined }: { data: LiveData; onWindow?: (w: Partial<LiveWindow>) => void }) {
  const sheet = data.sheets.find((s) => s.stageKey === data.window.stageKey) ?? data.sheets[0];
  const offset = data.window.offset;
  const total = sheet?.total ?? 0;
  return (
    <section dir="rtl" data-testid="live-cards" className="flex min-w-0 flex-col gap-2" aria-label={liveTitleOf(data)}>
      <div className="flex flex-col gap-1.5 rounded-[12px] bg-sf2 px-3 py-2">
        <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[14px] text-ink" role="status" data-testid="live-counter">
          <span className="text-ink2">{data.status === "done" ? LIVE_FINAL_COUNTER_TITLE_AR : LIVE_COUNTER_TITLE_AR}</span>
          <span className="min-w-0 break-words text-[18px] font-semibold">{data.counterAr}</span>
        </p>
        <LiveProgressBar data={data} />
      </div>
      {sheet ? <LiveSheetTabs data={data} activeKey={sheet.stageKey} onWindow={onWindow} /> : null}
      {sheet ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {data.window.rows.map((r) => {
            const { lead, rest } = cardFieldsOf(r, sheet.headers);
            return (
              <li key={r.id} className="min-w-0 rounded-[12px] border border-ln bg-sf p-3" data-testid="live-card">
                <FieldList fields={lead} />
                {rest.length > 0 ? (
                  <details className="mt-2" data-testid="live-card-more">
                    <summary className="min-h-11 cursor-pointer content-center text-[13px] text-ac">{LIVE_ALL_FIELDS_AR}</summary>
                    <div className="pt-1"><FieldList fields={rest} testId="live-card-rest" /></div>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {sheet ? <p className="m-0 text-center text-[12px] text-ink2" data-testid="live-cards-page">{pageLineAr(offset, data.window.rows.length, total)}</p> : null}
      <div className="flex flex-wrap justify-center gap-2">
        {offset > 0 ? <button type="button" className="min-h-11 rounded-full border border-ln2 px-4 text-[13px]" onClick={() => onWindow({ offset: prevOffsetOf(offset), limit: LIVE_PAGE_ROWS })}>{LIVE_BACK_AR}</button> : null}
        {offset + data.window.rows.length < total ? <button type="button" className="min-h-11 rounded-full border border-ln2 px-4 text-[13px]" onClick={() => onWindow({ offset: nextOffsetOf(offset, data.window.rows.length), limit: LIVE_PAGE_ROWS })}>{LIVE_MORE_AR}</button> : null}
      </div>
    </section>
  );
}

export default LiveSheetCards;
