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
      slug: c.slug,
      category: c.category,
      nameAr: c.nameAr,
      descriptionAr: c.descriptionAr,
      paramsSchema: parsedSchema,
      maxRows: c.maxRows,
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
