import { TablesDB } from "node-appwrite";
import { z } from "zod";

export interface Capability {
  slug: string;
  category: "x" | "youtube" | "tiktok" | "web";
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  paramsSchema: string; // JSON string
  tregEndpointId: string;
  tregMethod: "GET" | "POST";
  pricingUnit: "call" | "item" | "page";
  unitCostUsd: number;
  maxRows: number;
  paginationType: "cursor" | "offset" | "none";
  enabled: boolean;
}

export interface SanitizedCapabilityForLlm {
  slug: string;
  category: string;
  nameAr: string;
  descriptionAr: string;
  paramsSchema: any;
  maxRows: number;
}

const INTERNAL_TEXT = /\b(?:openai|chatgpt|gpt[-\s]?[3456][\w.-]*|treg|tikhub|serpapi|usd|dollars?|costs?|prices?|markup|api.?keys?|secrets?|passwords?|access.?tokens?)\b/gi;
const INTERNAL_KEY = /(?:cost|price|markup|provider|endpoint|token|secret|api.?key)/i;

function sanitizeCapabilityText(value: unknown, maxLength = 512): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(INTERNAL_TEXT, "")
    .replace(/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{12,}\b/gi, "")
    .replace(/\$\s?\d+(?:\.\d+)?/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeCapabilitySchema(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeCapabilitySchema(item, depth + 1)).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      if (INTERNAL_KEY.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
      const sanitized = sanitizeCapabilitySchema(item, depth + 1);
      if (sanitized !== undefined) clean[key] = sanitized;
    }
    return clean;
  }
  if (typeof value === "string") return sanitizeCapabilityText(value, 256);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

/**
 * Fetch all enabled capabilities from the server-only capability_registry table
 */
export async function getEnabledCapabilities(tables: TablesDB): Promise<Capability[]> {
  const res = await tables.listRows({
    databaseId: "digr",
    tableId: "capability_registry",
  });
  return (res.rows as unknown as Capability[]).filter((c) => c.enabled);
}

/**
 * Convert full capabilities into a sanitized format for the LLM
 * HARD RULE R1: Never leak endpoint IDs, provider names, costs, or pagination internals
 */
export function sanitizeCapabilitiesForLlm(capabilities: Capability[]): SanitizedCapabilityForLlm[] {
  return capabilities.map((c) => {
    let parsedSchema: any = {};
    try {
      parsedSchema = typeof c.paramsSchema === "string" ? JSON.parse(c.paramsSchema) : c.paramsSchema;
    } catch {
      parsedSchema = {};
    }
    return {
      slug: sanitizeCapabilityText(c.slug, 96),
      category: sanitizeCapabilityText(c.category, 32),
      nameAr: sanitizeCapabilityText(c.nameAr, 128),
      descriptionAr: sanitizeCapabilityText(c.descriptionAr, 512),
      paramsSchema: sanitizeCapabilitySchema(parsedSchema) || {},
      maxRows: Number.isSafeInteger(c.maxRows) && c.maxRows > 0 ? Math.min(c.maxRows, 100_000) : 0,
    };
  });
}

/**
 * Server-side parameter validation for a given capability slug
 */
export function validateCapabilityParams(
  capability: Capability,
  params: Record<string, any>
): { valid: boolean; errors?: string[] } {
  try {
    let schemaObj: any = {};
    try {
      schemaObj = typeof capability.paramsSchema === "string" ? JSON.parse(capability.paramsSchema) : capability.paramsSchema;
    } catch {
      return { valid: false, errors: ["Invalid capability schema configuration"] };
    }

    const errors: string[] = [];
    const required: string[] = schemaObj.required || [];

    for (const req of required) {
      if (params[req] === undefined || params[req] === null || params[req] === "") {
        errors.push(`الحقل المطلوب '${req}' مفقود`);
      }
    }

    const properties = schemaObj.properties || {};
    for (const [key, val] of Object.entries(params)) {
      const propDef = properties[key];
      if (propDef) {
        if (propDef.type === "string" && typeof val !== "string") {
          errors.push(`الحقل '${key}' يجب أن يكون نصاً`);
        } else if (propDef.type === "integer" && (!Number.isInteger(val) || typeof val !== "number")) {
          errors.push(`الحقل '${key}' يجب أن يكون رقماً صحيحاً`);
        }
        if (propDef.maximum !== undefined && typeof val === "number" && val > propDef.maximum) {
          errors.push(`الحقل '${key}' يتجاوز الحد الأقصى المسموح به (${propDef.maximum})`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (err: any) {
    return { valid: false, errors: [err.message] };
  }
}
