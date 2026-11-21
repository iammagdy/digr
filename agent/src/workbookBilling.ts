import ExcelJS from "exceljs";
import { isEmailColumn } from "../../src/lib/agentMission/contactFinders";
import { peopleWithoutRequestedContact, type BillablePlanLike, type ContactKindAsked, type UnbilledPeople } from "../../src/lib/agentMission/billableRows";
import { SUMMARY_SHEET_AR } from "../../src/lib/modelPlanner/missionWorkbook";

type Stage = BillablePlanLike["stages"][number];
type Column = NonNullable<Stage["columns"]>[number];

export interface WorkbookBillingSheet {
  name: string;
  headers: string[];
  stageKey: string;
  contacts: Array<{ column: number; key: string }>;
  thread?: {
    column: number;
    stageByLabel: Record<string, string>;
    idColumn?: number;
    stageByKindAndId?: Record<string, string>;
  };
}

export type WorkbookBillingLayout = WorkbookBillingSheet[];

export function requestedContactKinds(plan: BillablePlanLike, stage: Stage, column: Column): ContactKindAsked[] {
  if (column.status_of || column.type_of || column.computed) return [];
  const kinds = new Set<ContactKindAsked>();
  for (const step of plan.contact_steps ?? []) {
    if (step.stage_key !== stage.key || step.level !== undefined) continue;
    const native = step.kind === "email" ? isEmailColumn(column) : column.kind === "phone";
    if (column.key === step.column_key || native) kinds.add(step.kind);
  }
  return [...kinds];
}

export function workbookThreadKey(label: string, id: string): string {
  return JSON.stringify([label, id]);
}

const stripDirectionMarks = (value: string) => value.replace(/[\u202a-\u202e\u200e\u200f\u2066-\u2069]/g, "");

function contactValue(value: ExcelJS.CellValue): string | undefined {
  if (typeof value === "string") return stripDirectionMarks(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value && typeof value === "object" && "hyperlink" in value && typeof value.text === "string") {
    return stripDirectionMarks(value.text);
  }
  return undefined;
}

export async function readDeliveredWorkbook(
  bytes: Buffer,
  layout: WorkbookBillingLayout,
  plan: BillablePlanLike,
): Promise<{ ok: true; counts: Record<string, number>; unbilled: UnbilledPeople } | { ok: false; code: "workbook_invalid" | "layout_mismatch" }> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    return { ok: false, code: "workbook_invalid" };
  }
  const mismatch = { ok: false, code: "layout_mismatch" } as const;
  const worksheets = workbook.worksheets;
  if (worksheets[0]?.name !== SUMMARY_SHEET_AR || worksheets.length !== layout.length + 1) return mismatch;

  const dataSheets = workbook.worksheets.slice(1);
  const stages = new Map(plan.stages.filter((stage) => stage.deliver).map((stage) => [stage.key, stage]));
  const data = new Map<string, Array<Record<string, unknown>>>();
  for (let index = 0; index < layout.length; index += 1) {
    const binding = layout[index];
    const sheet = dataSheets[index];
    const stage = stages.get(binding.stageKey);
    if (!stage || sheet.name !== binding.name || binding.headers.length === 0 || sheet.columnCount !== binding.headers.length) return mismatch;
    if (new Set(binding.headers).size !== binding.headers.length ||
        binding.headers.some((header, i) => header !== sheet.getCell(1, i + 1).value)) return mismatch;
    const validColumn = (column: number) => Number.isInteger(column) && column > 0 && column <= binding.headers.length;
    const seenColumns = new Set<number>();
    const seenContacts = new Set<string>();
    for (const contact of binding.contacts) {
      const column = stage.columns?.find((c) => c.key === contact.key);
      if (!column || requestedContactKinds(plan, stage, column).length === 0 ||
          !validColumn(contact.column) || seenColumns.has(contact.column) || seenContacts.has(contact.key)) return mismatch;
      seenColumns.add(contact.column);
      seenContacts.add(contact.key);
    }
    const thread = binding.thread;
    if (thread && (!validColumn(thread.column) || seenColumns.has(thread.column) ||
        (thread.stageByKindAndId && (!thread.idColumn || !validColumn(thread.idColumn))))) return mismatch;
    let invalid = false;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1 || invalid) return;
      let nonempty = false;
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.value !== null && cell.value !== undefined && cell.value !== "") nonempty = true;
      });
      if (!nonempty) return;
      let stageKey = binding.stageKey;
      if (thread) {
        const label = row.getCell(thread.column).value;
        const id = thread.idColumn ? row.getCell(thread.idColumn).value : null;
        if (typeof label !== "string") { invalid = true; return; }
        const byId = thread.stageByKindAndId && typeof id === "string" ? thread.stageByKindAndId[workbookThreadKey(label, id)] : undefined;
        stageKey = byId ?? (Object.hasOwn(thread.stageByLabel, label) ? thread.stageByLabel[label] : "");
      }
      if (!stages.has(stageKey)) { invalid = true; return; }
      const cells: Record<string, unknown> = Object.create(null);
      if (stageKey === binding.stageKey) {
        for (const contact of binding.contacts) cells[contact.key] = contactValue(row.getCell(contact.column).value);
      }
      const rows = data.get(stageKey);
      if (rows) rows.push(cells);
      else data.set(stageKey, [cells]);
    });
    if (invalid) return mismatch;
  }
  const counts = Object.fromEntries([...data].map(([key, rows]) => [key, rows.length]));
  const target = (plan as BillablePlanLike & { price?: { deliveredRows: number } }).price?.deliveredRows;
  if (target !== undefined && Object.values(counts).reduce((sum, count) => sum + count, 0) > target) return mismatch;
  return { ok: true, counts, unbilled: peopleWithoutRequestedContact(plan, Object.fromEntries(data)) };
}
