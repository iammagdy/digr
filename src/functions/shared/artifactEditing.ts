import { z } from "zod";

const PlainField = z.string().trim().min(1).max(80).refine((value) => !["__proto__", "prototype", "constructor"].includes(value));
const Scalar = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);

export const ArtifactEditOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("filter"), field: PlainField, operator: z.enum(["equals", "contains", "gt", "gte", "lt", "lte", "is_empty", "not_empty"]), value: Scalar.optional() }).strict(),
  z.object({ action: z.literal("sort"), field: PlainField, direction: z.enum(["asc", "desc"]) }).strict(),
  z.object({ action: z.literal("select_columns"), columns: z.array(PlainField).min(1).max(80) }).strict(),
  z.object({ action: z.literal("rename_columns"), renames: z.record(z.string(), PlainField).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 40) }).strict(),
  z.object({ action: z.literal("dedupe"), keys: z.array(PlainField).min(1).max(10) }).strict(),
  z.object({ action: z.literal("group_aggregate"), groupBy: PlainField, metrics: z.array(z.object({ field: PlainField.optional(), operation: z.enum(["count", "sum", "average", "min", "max"]), as: PlainField }).strict()).min(1).max(10) }).strict(),
  z.object({ action: z.literal("anonymize"), fields: z.array(PlainField).min(1).max(40) }).strict(),
  z.object({ action: z.literal("rewrite_summary"), summaryAr: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ action: z.literal("convert_formats"), formats: z.array(z.enum(["xlsx", "pdf", "csv"])).min(1).max(3) }).strict(),
]);

export type ArtifactEditOperation = z.infer<typeof ArtifactEditOperationSchema>;
export type ArtifactResultPayload = {
  rows?: Array<Record<string, unknown>>;
  profile?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "ar", { numeric: true, sensitivity: "base" });
}

function rowsFrom(payload: ArtifactResultPayload): Array<Record<string, unknown>> {
  const source = Array.isArray(payload.rows) ? payload.rows : payload.profile ? [payload.profile] : [];
  return source.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)).slice(0, 5000);
}

export function applyArtifactEdit(payload: ArtifactResultPayload, operationInput: unknown): ArtifactResultPayload {
  const operation = ArtifactEditOperationSchema.parse(operationInput);
  let rows = rowsFrom(payload).map((row) => ({ ...row }));
  const metadata = { ...(payload.metadata || {}) };

  switch (operation.action) {
    case "filter": {
      rows = rows.filter((row) => {
        const value = row[operation.field];
        if (operation.operator === "is_empty") return value === null || value === undefined || value === "";
        if (operation.operator === "not_empty") return value !== null && value !== undefined && value !== "";
        if (operation.operator === "contains") return String(value ?? "").toLocaleLowerCase().includes(String(operation.value ?? "").toLocaleLowerCase());
        const order = compare(value, operation.value);
        if (operation.operator === "equals") return order === 0;
        if (operation.operator === "gt") return order > 0;
        if (operation.operator === "gte") return order >= 0;
        if (operation.operator === "lt") return order < 0;
        return order <= 0;
      });
      break;
    }
    case "sort":
      rows.sort((a, b) => compare(a[operation.field], b[operation.field]) * (operation.direction === "asc" ? 1 : -1));
      break;
    case "select_columns":
      rows = rows.map((row) => Object.fromEntries(operation.columns.filter((key) => Object.prototype.hasOwnProperty.call(row, key)).map((key) => [key, row[key]])));
      break;
    case "rename_columns":
      rows = rows.map((row) => {
        const next: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) next[operation.renames[key] || key] = value;
        return next;
      });
      break;
    case "dedupe": {
      const seen = new Set<string>();
      rows = rows.filter((row) => {
        const values = operation.keys.some((key) => Object.prototype.hasOwnProperty.call(row, key))
          ? Object.fromEntries(operation.keys.map((key) => [key, row[key]]))
          : row;
        const fingerprint = stable(values);
        if (seen.has(fingerprint)) return false;
        seen.add(fingerprint);
        return true;
      });
      break;
    }
    case "group_aggregate": {
      const groups = new Map<string, { keyValue: unknown; rows: Array<Record<string, unknown>> }>();
      for (const row of rows) {
        const keyValue = row[operation.groupBy] ?? null;
        const key = stable(keyValue);
        const group = groups.get(key) || { keyValue, rows: [] };
        group.rows.push(row);
        groups.set(key, group);
      }
      rows = Array.from(groups.values()).map((group) => {
        const result: Record<string, unknown> = { [operation.groupBy]: group.keyValue };
        for (const metric of operation.metrics) {
          const values = metric.field ? group.rows.map((row) => row[metric.field!]).filter((value): value is number => typeof value === "number" && Number.isFinite(value)) : [];
          if (metric.operation === "count") result[metric.as] = group.rows.length;
          else if (metric.operation === "sum") result[metric.as] = values.reduce((sum, value) => sum + value, 0);
          else if (metric.operation === "average") result[metric.as] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
          else if (metric.operation === "min") result[metric.as] = values.length ? Math.min(...values) : null;
          else result[metric.as] = values.length ? Math.max(...values) : null;
        }
        return result;
      });
      break;
    }
    case "anonymize":
      rows = rows.map((row) => {
        const next = { ...row };
        for (const field of operation.fields) delete next[field];
        return next;
      });
      break;
    case "rewrite_summary":
      metadata.summaryAr = operation.summaryAr.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000);
      break;
    case "convert_formats":
      metadata.formats = Array.from(new Set(operation.formats));
      break;
  }

  return { ...payload, profile: null, rows, metadata };
}
