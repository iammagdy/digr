import { readFileSync } from "node:fs";
import { classifyBeforeGuide, classifyUnderstandingRequest } from "../src/functions/shared/understandingRequests";

type Case = { id: string; category: string; request: string; expectedCapability: string; expectedMissingInputs: string[] };
const cases = JSON.parse(readFileSync("tests/fixtures/understanding-requests.json", "utf8")) as Case[];

function evaluate(label: string, classify: typeof classifyUnderstandingRequest) {
  const byCategory = new Map<string, { total: number; correct: number; failures: string[] }>();
  for (const item of cases) {
    const result = classify(item.request);
    const state = byCategory.get(item.category) || { total: 0, correct: 0, failures: [] };
    state.total++;
    const pass = result.capability === item.expectedCapability &&
      JSON.stringify([...result.missingInputs].sort()) === JSON.stringify([...item.expectedMissingInputs].sort());
    if (pass) state.correct++;
    else state.failures.push(`${item.id}: expected ${item.expectedCapability} missing=${item.expectedMissingInputs.join(",") || "none"}; got ${result.capability} missing=${result.missingInputs.join(",") || "none"}`);
    byCategory.set(item.category, state);
  }
  const rows = [...byCategory].map(([category, state]) => ({ category, accuracy: `${state.correct}/${state.total}`, failures: state.failures }));
  const correct = [...byCategory.values()].reduce((n, state) => n + state.correct, 0);
  process.stdout.write(`${label}: ${correct}/${cases.length}\n${JSON.stringify(rows, null, 2)}\n`);
}

evaluate("before guide (legacy offline router proxy)", classifyBeforeGuide);
evaluate("after guide (structured offline classifier)", classifyUnderstandingRequest);
