import { foldDigits } from "../arabicNormalize";
import { toBool } from "../coerce";
import type { CatalogInput } from "../treg/catalog";
import type { PlanParam, ValidationIssue } from "./types";

const WINDOW_TOKENS = new Set(["date", "dates", "from", "to", "since", "until", "start", "end", "period", "window", "time", "timeframe", "days", "recent", "published", "posted", "range", "year", "month", "week", "after", "before", "interval", "timespan", "daterange"]);
const tokensOfName = (name: string): string[] => String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((t) => t.toLowerCase());
/** A parameter that sets a period (datePosted, publish_time, since, start_date…): never set without the customer's own words about the period. */
export function isWindowParamName(name: string): boolean {
  const tokens = tokensOfName(name);
  if (tokens.includes("sort") || tokens.includes("order")) return false;
  return tokens.some((t) => WINDOW_TOKENS.has(t));
}

const typeClass = (t: string | null): "string" | "int" | "number" | "bool" | "array" | "object" | "any" => {
  const s = String(t ?? "").toLowerCase();
  if (/^(integer|int)(,|$)/.test(s) || s === "integer" || s === "int") return "int";
  if (s === "number" || s === "float" || s === "double") return "number";
  if (s === "boolean" || s === "bool") return "bool";
  if (s.startsWith("array") || s === "list" || s === "string_or_array" || /list$/.test(s)) return "array";
  if (s === "object" || s === "dict") return "object";
  if (s === "string" || s === "str" || s === "url" || s === "text") return "string";
  return "any";
};

/** Checks a value against what the catalog says the parameter takes. Returns a problem or null. */
export function checkParamValue(input: CatalogInput, value: unknown): { code: ValidationIssue["code"]; message: string } | null {
  const cls = typeClass(input.type);
  const name = input.name;
  if (cls === "int" || cls === "number") {
    const n = typeof value === "number" ? value : Number(foldDigits(String(value)));
    if (!Number.isFinite(n)) return { code: "bad_param_type", message: `parameter «${name}» takes a number, got «${String(value).slice(0, 40)}»` };
    if (cls === "int" && !Number.isInteger(n)) return { code: "bad_param_type", message: `parameter «${name}» takes a whole number` };
    if (input.minimum !== null && n < input.minimum) return { code: "bad_param_range", message: `parameter «${name}» must be at least ${input.minimum}` };
    if (input.maximum !== null && n > input.maximum) return { code: "bad_param_range", message: `parameter «${name}» must be at most ${input.maximum}` };
  } else if (cls === "bool") {
    if (toBool(value) === undefined) return { code: "bad_param_type", message: `parameter «${name}» takes true or false` };
  } else if (cls === "array") {
    if (!Array.isArray(value) && typeof value !== "string") return { code: "bad_param_type", message: `parameter «${name}» takes a list` };
  } else if (cls === "string") {
    if (typeof value !== "string" && typeof value !== "number") return { code: "bad_param_type", message: `parameter «${name}» takes text` };
  }
  if (Array.isArray(input.enum) && input.enum.length > 0) {
    const allowed = input.enum.map((e) => String(e));
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    if (!values.every((v) => allowed.includes(v))) return { code: "bad_param_enum", message: `parameter «${name}» must be one of: ${allowed.slice(0, 20).join(", ")}` };
  }
  return null;
}

/** The value a param sends: its value, or the customer's quote when no value was given. */
export function resolvedParamValue(p: PlanParam): unknown {
  if (p.source === "prior_step") return undefined;
  return p.value !== undefined ? p.value : p.quote;
}

