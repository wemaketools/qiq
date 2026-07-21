/**
 * The "some tenants succeeded, some did not" signal shared by the T-032 expiry sweeps.
 *
 * `runCronJob` records counts only on the SUCCESS path (`jobRuns.fail(jobRunId, error)` takes no
 * counts), so without carrying them in the message a partially-failed sweep would leave a job_run
 * row that says nothing about the work that DID complete — and an operator would see a red run with
 * no way to tell "one tenant is misconfigured" from "the sweep did nothing at all".
 *
 * Both failing tenant ids and partial counts therefore travel in the message. Ids and counts only:
 * never a lead ref, a party name or a premium (spec §15).
 *
 * T-033's `alert-evaluation.ts` declares its own equivalent class. It is deliberately NOT refactored
 * to use this one: that file is a passed task, and the shared shape here exists because THIS task
 * has two real callers of it. If a third sweep lands, collapsing the two is a one-line change.
 */
export class PartialSweepError extends Error {
  constructor(
    readonly jobName: string,
    readonly failedTenantIds: readonly number[],
    readonly counts: Readonly<Record<string, number>>,
  ) {
    super(
      `${jobName} completed with per-tenant failures. failedTenantIds=[${failedTenantIds.join(',')}] ` +
        `counts=${JSON.stringify(counts)}`,
    );
    this.name = 'PartialSweepError';
  }
}
