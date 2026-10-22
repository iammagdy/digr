import { estimatePageProviderUsd, maxPagesForJob, type CapKind } from "./providerCallCaps";

/**
 * The default provider-spend ceiling of ONE job, for every kind of job including a capability the code does not recognise.
 * (22 Oct 2026: a job of an unrecognised kind had neither a page limit nor a spend ceiling and spent 0.866 USD on 175 pages that all
 * delivered nothing, against 0.025 USD expected.)
 *
 * The expected provider cost of a plan is the pages it needs if every record matches, times what one page costs (a directory bills every
 * requested record, a feed bills per call). The ceiling is 3 times that, never more than 0.05 USD, unless the plan itself is expected to
 * cost more than 0.05 USD: then it is 3 times its own expected cost. A feed keeps at least what its own (approved) page limit allows, so
 * this ceiling never undoes the page allowance of large social jobs. An owner-set per-job ceiling (admin limits) replaces this default.
 * It never changes a customer price: a job stopped by it settles with what it collected and releases the rest.
 */
export const JOB_SPEND_MULTIPLE = 3;
export const JOB_SPEND_ABSOLUTE_MAX_USD = 0.05;

export interface JobSpendCeilingInput {
  unitCostUsd: number;
  targetMax: number;
  pageSize: number;
  kind: CapKind;
  /** The source bills every record REQUESTED on a page (directories and unknown item-priced sources) rather than per call. */
  billsPerRequestedRecord: boolean;
}

/** What the plan is expected to cost the provider if every record matches. */
export function expectedJobProviderUsd(input: JobSpendCeilingInput): number {
  const pageSize = Math.max(1, Math.floor(input.pageSize));
  const needed = Math.max(1, Math.ceil(Math.max(1, input.targetMax) / pageSize));
  return needed * estimatePageProviderUsd(input.unitCostUsd, pageSize, input.billsPerRequestedRecord);
}

export function defaultJobProviderCeilingUsd(input: JobSpendCeilingInput): number {
  const expected = expectedJobProviderUsd(input);
  const threeTimes = expected * JOB_SPEND_MULTIPLE;
  let ceiling = expected > JOB_SPEND_ABSOLUTE_MAX_USD ? threeTimes : Math.min(threeTimes, JOB_SPEND_ABSOLUTE_MAX_USD);
  if (input.kind === "feed") {
    const pageSize = Math.max(1, Math.floor(input.pageSize));
    ceiling = Math.max(ceiling, maxPagesForJob(input.targetMax, pageSize, "feed") * estimatePageProviderUsd(input.unitCostUsd, pageSize, input.billsPerRequestedRecord));
  }
  return Number(ceiling.toFixed(6));
}
