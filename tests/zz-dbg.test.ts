import { it } from "vitest";
import { runS4 } from "./helpers/s4World";
it("dbg", async () => {
  const r = await runS4();
  const props = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
  console.log("PROPOSALS", JSON.stringify(props.map((p) => p.result)).slice(0, 900));
  console.log("GAPS", JSON.stringify(r.plannedPlan.stages[0].engine?.gaps), r.plannedPlan.stages[0].engine?.built_by, r.plannedPlan.stages[0].endpoint_id);
});
