import { facebookTopicCostReport } from "../src/lib/costEstimate";

// Read-only: prints the cost estimate of the 300-post / 5-comments-per-post Facebook topic request. No call is made.
const report = facebookTopicCostReport();
console.log(JSON.stringify(report, null, 2));
