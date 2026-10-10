import { Client, TablesDB, Databases } from "node-appwrite";

const client = new Client();
const tables = new TablesDB(client);
console.log("TablesDB methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(tables)).filter(m => m.includes("Column") || m.includes("Attribute") || m.includes("Table")));

const dbs = new Databases(client);
console.log("Databases attribute methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(dbs)).filter(m => m.includes("Attribute")));
