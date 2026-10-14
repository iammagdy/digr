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

let appwriteSdk: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  appwriteSdk = require("node-appwrite");
} catch {
  appwriteSdk = null;
}

class FallbackTablesDB {
  client: any;
  constructor(client?: any) {
    this.client = client;
  }
  async getRow(...args: any[]) {
    return this.client?.getRow ? this.client.getRow(...args) : {};
  }
  async createRow(...args: any[]) {
    return this.client?.createRow ? this.client.createRow(...args) : { $id: ID.unique() };
  }
  async updateRow(...args: any[]) {
    return this.client?.updateRow ? this.client.updateRow(...args) : {};
  }
  async listRows(...args: any[]) {
    return this.client?.listRows ? this.client.listRows(...args) : { rows: [], total: 0 };
  }
}

class FallbackMessaging {
  client: any;
  constructor(client?: any) {
    this.client = client;
  }
  async createEmail(...args: any[]) {
    return this.client?.createEmail ? this.client.createEmail(...args) : { $id: ID.unique() };
  }
}

class FallbackUsers {
  client: any;
  constructor(client?: any) {
    this.client = client;
  }
  async get(...args: any[]) {
    return this.client?.get ? this.client.get(...args) : { $id: "", prefs: {}, email: "" };
  }
}

export const TablesDB = appwriteSdk?.TablesDB || FallbackTablesDB;
export type TablesDB = any;

export type Storage = any;

export const Messaging = appwriteSdk?.Messaging || FallbackMessaging;
export type Messaging = any;

export const Users = appwriteSdk?.Users || FallbackUsers;
export type Users = any;
