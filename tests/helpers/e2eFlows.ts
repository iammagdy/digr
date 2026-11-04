import { runAddonSafely } from "../../agent/src/stage4/runAddon";
import { api, json } from "./e2eRoutes";
import { MISSION, type E2eWorld } from "./e2eWorld";

/**
 * STAGE F: THE PAID STEPS OF A FLOW, in the order a customer meets them. The routes make the unpaid request, the REAL approval of the existing money core (fake clients only) holds the price, and the REAL worker runner does the work and settles.
 * There is no live approval endpoint (docs/STAGE-4-APPROVAL-BOUNDARY.md): approval is called as a function, never as a route.
 */
export async function paidReview(w: E2eWorld, version = 1) {
  const quote = (await json(await api.reviewQuote(MISSION, `version=${version}`))).quote;
  const made = await json(await api.reviewRequestPost({ action: "create", version }));
  const a = await w.approveAndClaim(made.request.id);
  await runAddonSafely(w.deps, a.row);
  return { quote, request: made.request, a, P: quote.points as number };
}

/** An edit the customer typed: quote, prepare, approve (hold), run. Returns what each step answered. */
export async function paidEdit(w: E2eWorld, edit: unknown, version = 1) {
  const quote = (await json(await api.editRequestPost({ action: "quote", version, edit }))).quote;
  const madeRes = await api.editRequestPost({ action: "create", version, edit });
  const made = await json(madeRes);
  const a = await w.approveAndClaim(made.request.id);
  await runAddonSafely(w.deps, a.row);
  return { quote, request: made.request, a, R: a.hold };
}
