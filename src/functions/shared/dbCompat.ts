import crypto from "node:crypto";

/**
 * Self-contained database and query compatibility primitives.
 * Replaces node-appwrite SDK dependency across the shared runtime.
 */

export const ID = {
  unique: () => crypto.randomUUID().replace(/-/g, "").slice(0, 20),
};

export const Query = {
  equal: (attr: string, val: any) => JSON.stringify({ method: "equal", attribute: attr, values: Array.isArray(val) ? val : [val] }),
  notEqual: (attr: string, val: any) => JSON.stringify({ method: "notEqual", attribute: attr, values: Array.isArray(val) ? val : [val] }),
  greaterThanEqual: (attr: string, val: any) => JSON.stringify({ method: "greaterThanEqual", attribute: attr, values: [val] }),
  lessThanEqual: (attr: string, val: any) => JSON.stringify({ method: "lessThanEqual", attribute: attr, values: [val] }),
  lessThan: (attr: string, val: any) => JSON.stringify({ method: "lessThan", attribute: attr, values: [val] }),
  orderAsc: (attr: string) => JSON.stringify({ method: "orderAsc", attribute: attr }),
  orderDesc: (attr: string) => JSON.stringify({ method: "orderDesc", attribute: attr }),
  limit: (limit: number) => JSON.stringify({ method: "limit", values: [limit] }),
  offset: (offset: number) => JSON.stringify({ method: "offset", values: [offset] }),
};

export const Role = {
  user: (id: string) => `user:${id}`,
  label: (l: string) => `label:${l}`,
  any: () => "any",
};

export const Permission = {
  read: (role: string) => `read("${role}")`,
  write: (role: string) => `write("${role}")`,
  update: (role: string) => `update("${role}")`,
  delete: (role: string) => `delete("${role}")`,
};

export type TablesDB = any;
export type Storage = any;
