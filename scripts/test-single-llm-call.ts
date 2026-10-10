import OpenAI from "openai";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY not found in .env.local");
    process.exit(1);
  }

  const client = new OpenAI({ apiKey });
  const model = process.env.LLM_MODEL || "gpt-6-luna";
  console.log("Testing 1 tiny call with model:", model);

  try {
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "قل مرحباً فقط" }],
      max_completion_tokens: 50,
      reasoning_effort: "low",
    });
    console.log("Success! Output:", res.choices[0]?.message?.content);
    console.log("Usage:", res.usage);
  } catch (err: any) {
    console.error("OpenAI call failed:", err.message);
  }
}

main();
