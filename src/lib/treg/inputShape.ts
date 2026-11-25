import type { CatalogEndpoint } from "./catalog";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Generic schema-driven preflight for endpoint input shapes (c2): validates declared array and nested object-field array
 * expectations from catalog metadata before dispatching to the gateway, leaving valid arrays and string inputs untouched.
 */
export function validateInputShape(endpoint: CatalogEndpoint | undefined, params: unknown): string | null {
  if (!endpoint || !isObject(params)) return null;
  for (const inp of endpoint.inputs) {
    const val = params[inp.name];
    if (val === undefined) continue;
    if (inp.type && /^array(?:\[|$)/i.test(inp.type) && !Array.isArray(val)) {
      return `invalid input shape for «${inp.name}»: expected ${inp.type} (an array), got ${val === null ? "null" : typeof val}${inp.example !== null && inp.example !== undefined ? ` (example: ${JSON.stringify(inp.example)})` : ""}. Pass an array and retry.`;
    }
    if (inp.fields && isObject(val)) {
      for (const [subKey, spec] of Object.entries(inp.fields)) {
        const subVal = val[subKey];
        if (subVal === undefined || !/^array(?:\[|$)/i.test(spec.type)) continue;
        if (!Array.isArray(subVal)) {
          return `invalid input shape for «${inp.name}.${subKey}»: expected ${spec.type} (an array), got ${subVal === null ? "null" : typeof subVal}${spec.example !== undefined ? ` (example: ${JSON.stringify(spec.example)})` : ""}. Pass an array of strings and retry.`;
        }
        if (/^array\[string\]$/i.test(spec.type) && subVal.some((x) => typeof x !== "string" || x.trim() === "")) {
          return `invalid input shape for «${inp.name}.${subKey}»: expected ${spec.type} (array of non-empty strings).`;
        }
      }
    }
  }
  return null;
}
