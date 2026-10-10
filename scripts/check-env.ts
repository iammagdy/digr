import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

console.log("TREG_TOKEN set:", Boolean(process.env.TREG_TOKEN || process.env.TREG_API_KEY));
console.log("APPWRITE_API_KEY set:", Boolean(process.env.APPWRITE_API_KEY));
console.log("OPENAI_API_KEY set:", Boolean(process.env.OPENAI_API_KEY));
console.log("TREG_LIVE:", process.env.TREG_LIVE);
