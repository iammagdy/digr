import OpenAI from "openai";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const apiKey = process.env.OPENAI_API_KEY!;

async function testValidParams() {
  const openai = new OpenAI({ apiKey });
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-6-luna",
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "You are a data assistant. Always output a valid JSON object matching the schema." },
        { role: "user", content: "test" }
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 350,
    });
    console.log("✅ Success! Response:", res.choices[0]?.message?.content);
    console.log("✅ Usage:", res.usage);
  } catch (err: any) {
    console.error("❌ Rejected params error:", err.message);
  }
}

testValidParams();
