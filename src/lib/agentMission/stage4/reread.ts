import { STATED_GAP } from "./review";

/**
 * MONEY PR 7a, PHASE 2B-1: THE RE-READ RECIPE OF AN EDIT OR A REVIEW FIX (docs/MONEY-PR-7A.md section 2, 13). The card (priced by code, approved by the customer) carries WHAT will be read: for each target column, the chain of tools
 * in order, each with its fixed inputs, the input that takes a value of the row, and the field of an answer row that holds the value. The worker only CARRIES IT OUT; it never plans, never chooses a tool and never decides a price.
 * Pure: types, a strict reader, a path reader and the rule of what counts as a value (decision D4: a stated gap is not a value).
 */
export interface RereadTool {
  endpointId: string;
  /** The fixed inputs of every call of this tool. */
  params: Readonly<Record<string, unknown>>;
  /** The input that takes the row's own value (`from`: the header of the column of the base version whose cell is sent). */
  bind: { param: string; from: string };
  /** The field of a row of the answer that holds the value (a key, or a dotted path). */
  valueField: string;
}
export interface RereadRecipe { tools: ReadonlyArray<RereadTool> }

/** A chain is short: every tool is tried for a row that the one before could not fill, and every try is a paid call. */
export const REREAD_MAX_TOOLS = 6;

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The recipe of a stored request, or null when it is not a well-formed one (nothing is guessed). */
export function readRecipe(raw: unknown): RereadRecipe | null {
  if (!isObject(raw) || !Array.isArray(raw.tools) || raw.tools.length === 0 || raw.tools.length > REREAD_MAX_TOOLS) return null;
  const tools: RereadTool[] = [];
  for (const t of raw.tools) {
    if (!isObject(t) || !isText(t.endpointId) || !isObject(t.params) || !isObject(t.bind) || !isText(t.bind.param) || !isText(t.bind.from) || !isText(t.valueField)) return null;
    tools.push({ endpointId: t.endpointId.trim(), params: { ...t.params }, bind: { param: t.bind.param.trim(), from: t.bind.from.trim() }, valueField: t.valueField.trim() });
  }
  return { tools };
}

/** A value of a row by key or dotted path («author.name»); undefined when it is not there. */
export function valueAtPath(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const key of path.split(".")) {
    if (!isObject(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined || cur === null) return undefined;
  }
  return cur;
}

/** The text a customer sees of a value (a text or a finite number; a boolean, an object, a list or nothing is not a value). */
export function cellText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** DECISION D4: only a REAL value counts as filled. An empty cell, «غير متوفر», «غير متاح», «لم يكتمل البحث» (and the other stated gaps) are not values. */
export function isRealValue(v: unknown): boolean {
  const t = cellText(v);
  return t !== "" && !STATED_GAP.test(t);
}
