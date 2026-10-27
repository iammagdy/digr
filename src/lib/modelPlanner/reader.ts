import { readShape, type ShapeHints, type ShapeReading } from "../treg/shapeReader";
import type { StepFacts } from "./types";

/**
 * THE ONE READER of a model plan's answers. `sample_call` (at planning time) and the worker (at run time) both read an answer with `readStepRows`, with hints made by
 * `stepReaderHints` from the same facts: where the list sits, whether the answer is ONE record read as the answer itself, the cursor and the declared field types. The facts are
 * written from the SAMPLE'S own reading, so the worker reads a real answer the way the sample did (a single-object answer is one row, never an empty list).
 */
export type ReaderFacts = Pick<StepFacts, "listPath" | "cursorPath" | "itemFields" | "rootObjectIsRow">;

export function stepReaderHints(facts: ReaderFacts): ShapeHints {
  const noList = facts.listPath === null || facts.listPath === undefined || facts.listPath === "NOT FOUND";
  return { listPath: facts.listPath, cursorPath: facts.cursorPath, itemFields: facts.itemFields, ...(facts.rootObjectIsRow || noList ? { rootObjectIsRow: true } : {}) };
}

export function readStepRows(body: unknown, facts: ReaderFacts): ShapeReading {
  return readShape(body, stepReaderHints(facts));
}
