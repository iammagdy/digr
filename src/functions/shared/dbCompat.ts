/**
 * Self-contained database and query compatibility primitives.
 * Replaces node-appwrite SDK dependency across the shared runtime.
 */

export const ID = {
  unique: () => {
    if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    }
    return Math.random().toString(36).substring(2, 12) + Math.random().toString(36).substring(2, 12);
  },
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

export class TablesDB {
  client: any;
  constructor(client?: any) {
    this.client = client;
  }
  async getRow(...args: any[]) {
    if (typeof this.client?.getRow === "function") {
      return this.client.getRow(...args);
    }
    throw new Error("TablesDB: getRow is not supported by the provided database client.");
  }
  async createRow(...args: any[]) {
    if (typeof this.client?.createRow === "function") {
      return this.client.createRow(...args);
    }
    throw new Error("TablesDB: createRow is not supported by the provided database client.");
  }
  async updateRow(...args: any[]) {
    if (typeof this.client?.updateRow === "function") {
      return this.client.updateRow(...args);
    }
    throw new Error("TablesDB: updateRow is not supported by the provided database client.");
  }
  async listRows(...args: any[]) {
    if (typeof this.client?.listRows === "function") {
      return this.client.listRows(...args);
    }
    throw new Error("TablesDB: listRows is not supported by the provided database client.");
  }
}

export class Client {
  endpoint = "";
  project = "";
  key = "";
  setEndpoint(endpoint: string) { this.endpoint = endpoint; return this; }
  setProject(project: string) { this.project = project; return this; }
  setKey(key?: string) { this.key = key || ""; return this; }
}

export class Functions {
  client: any;
  constructor(client?: any) { this.client = client; }
  async createExecution(...args: any[]) {
    if (typeof this.client?.createExecution === "function") {
      return this.client.createExecution(...args);
    }
    throw new Error("Functions: createExecution is not supported by the provided client.");
  }
}

export class Storage {
  client: any;
  constructor(client?: any) { this.client = client; }
  async getFile(...args: any[]) {
    if (typeof this.client?.getFile === "function") return this.client.getFile(...args);
    throw new Error("Storage: getFile is not supported by the provided client.");
  }
  async getFileDownload(...args: any[]) {
    if (typeof this.client?.getFileDownload === "function") return this.client.getFileDownload(...args);
    throw new Error("Storage: getFileDownload is not supported by the provided client.");
  }
  async createFile(...args: any[]) {
    if (typeof this.client?.createFile === "function") return this.client.createFile(...args);
    throw new Error("Storage: createFile is not supported by the provided client.");
  }
  async deleteFile(...args: any[]) {
    if (typeof this.client?.deleteFile === "function") return this.client.deleteFile(...args);
    throw new Error("Storage: deleteFile is not supported by the provided client.");
  }
  async updateFile(...args: any[]) {
    if (typeof this.client?.updateFile === "function") return this.client.updateFile(...args);
    throw new Error("Storage: updateFile is not supported by the provided client.");
  }
}

export class Messaging {
  client: any;
  constructor(client?: any) {
    this.client = client;
  }
  async createEmail(...args: any[]) {
    if (typeof this.client?.createEmail === "function") {
      return this.client.createEmail(...args);
    }
    throw new Error("Messaging: createEmail is not supported by the provided client.");
  }
}

export class Users {
  client: any;
  constructor(client?: any) {
    this.client = client;
  }
  async get(...args: any[]) {
    if (typeof this.client?.get === "function") {
      return this.client.get(...args);
    }
    throw new Error("Users: get is not supported by the provided client.");
  }
  async updatePrefs(...args: any[]) {
    if (typeof this.client?.updatePrefs === "function") return this.client.updatePrefs(...args);
    throw new Error("Users: updatePrefs is not supported by the provided client.");
  }
  async deleteSessions(...args: any[]) {
    if (typeof this.client?.deleteSessions === "function") return this.client.deleteSessions(...args);
    throw new Error("Users: deleteSessions is not supported by the provided client.");
  }
  async updateStatus(...args: any[]) {
    if (typeof this.client?.updateStatus === "function") return this.client.updateStatus(...args);
    throw new Error("Users: updateStatus is not supported by the provided client.");
  }
}
