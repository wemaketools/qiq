/**
 * The SLA/Turnaround and Pipeline Aging report computations (T-040; AC-083; V-106; spec FR-60,
 * AC-059, PRD 17.1/19.1).
 *
 * Port of `SlaTurnaroundReportQueryHandler.cs` and `PipelineAgingReportQueryHandler.cs`.
 *
 * PURE FUNCTIONS OVER A SNAPSHOT, WITH THE INSTANT INJECTED
 * ========================================================
 * Everything here takes `(snapshot, settings, now)` and returns a payload. No clock is read inside
 * and no query is issued, so an integration test can assert an EXACT breach count and an EXACT
 * average rather than a shape — which is the only way to tell a working SLA report from one that
 * silently counts nothing.
 *
 * THE BREACH THRESHOLDS ARE THE TENANT'S ALERT THRESHOLDS
 * ======================================================
 * `sla_assignment_days`, `sla_underwriting_days` and `sla_received_to_sent_days` are the same
 * settings the T-024 alert rules fire on. Re-deriving "what counts as breaching" here would let the
 * Alerts SLA tab and this report disagree about the same lead, which is unfalsifiable from the UI.
 */
import { averageTurnaroundDays } from '../dashboards/metrics/index.js';
import { LEAD_STATUS_KEYS } from '../leads/workflow/legality.js';
import type { Money } from '../dashboards/money.js';
import type { SlaLeadRow, SlaReportSnapshot } from './store.js';

/** The reporting categories that mean "still in play" (`ReportingCategory.Open`/`Quoted`). */
const OPEN_CATEGORIES: readonly string[] = ['open', 'quoted'];

/** The tenant thresholds these two reports read. */
export interface SlaReportSettings {
  readonly currencyCode: string;
  readonly slaAssignmentDays: number;
  readonly slaUnderwritingDays: number;
  readonly slaReceivedToSentDays: number;
}

export interface SlaMetricDto {
  readonly key: string;
  readonly label: string;
  readonly averageDays: number | null;
  readonly targetDays: number | null;
}

export interface SlaBreachByStageDto {
  readonly stage: string;
  readonly breachCount: number;
  readonly targetDays: number;
}

export interface UnderwritingDelayRowDto {
  readonly leadId: number;
  readonly leadRef: string;
  readonly clientName: string;
  readonly ownerName: string | null;
  readonly daysInUnderwriting: number;
  readonly targetDays: number;
  readonly premiumAtRisk: Money | null;
}

export interface TurnaroundByProductLineDto {
  readonly productLineId: number;
  readonly productLineName: string;
  readonly averageTurnaroundDays: number | null;
}

export interface SlaTurnaroundReportDto {
  readonly currencyCode: string;
  readonly metrics: readonly SlaMetricDto[];
  readonly breachesByStage: readonly SlaBreachByStageDto[];
  readonly underwritingDelayQueue: readonly UnderwritingDelayRowDto[];
  readonly turnaroundByProductLine: readonly TurnaroundByProductLineDto[];
}

export interface PipelineAgingRowDto {
  readonly leadId: number;
  readonly leadRef: string;
  readonly clientName: string;
  readonly stageName: string;
  readonly ageDays: number;
  readonly ageBucket: string;
  readonly ownerName: string | null;
  readonly premium: Money | null;
}

export interface PipelineAgingReportDto {
  readonly currencyCode: string;
  readonly rows: readonly PipelineAgingRowDto[];
}

/** Whole days between two `yyyy-MM-dd` dates — `DateOnly.DayNumber` arithmetic, never a local clock. */
function dayNumber(date: string): number {
  return Math.round(new Date(`${date}T00:00:00Z`).getTime() / 86_400_000);
}

/** Fractional days between two instants (`(a - b).TotalDays`). */
function totalDays(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

/** `Average(...)` (:145-149) — null on an empty set, rounded to 2dp. NOT zero: no data is not "instant". */
function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return Math.round(mean * 100) / 100;
}

/** `DateOnly.FromDateTime(value.UtcDateTime)` — a UTC instant reduced to its date. */
function utcDateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function isOpen(category: string): boolean {
  return OPEN_CATEGORIES.includes(category);
}

/**
 * `BuildMetrics` (:47-93) — the six PRD 17.1 lifecycle legs.
 *
 * Every leg filters out NEGATIVE durations (`days >= 0`) before averaging. That is not defensive
 * noise: a quote prepared before its lead was received is a data error, and letting it through would
 * drag an average down by an arbitrary amount with no visible cause on a printed page.
 */
function buildMetrics(
  snapshot: SlaReportSnapshot,
  settings: SlaReportSettings,
): readonly SlaMetricDto[] {
  const receivedToAssignment = average(
    snapshot.leads
      .filter((lead) => lead.dateAssigned !== null)
      .map((lead) => dayNumber(utcDateOf(lead.dateAssigned as Date)) - dayNumber(lead.dateReceived))
      .filter((days) => days >= 0),
  );

  const receivedToPrepared = average(
    snapshot.quotes
      .map((quote) => dayNumber(quote.preparedDate) - dayNumber(quote.leadDateReceived))
      .filter((days) => days >= 0),
  );

  const preparedToSent = average(
    snapshot.quotes
      .filter((quote) => quote.sentDate !== null)
      .map((quote) => dayNumber(quote.sentDate as string) - dayNumber(quote.preparedDate))
      .filter((days) => days >= 0),
  );

  const sentToDecision = average(
    snapshot.quotes
      .filter((quote) => quote.sentDate !== null && quote.decisionDate !== null)
      .map((quote) => dayNumber(quote.decisionDate as string) - dayNumber(quote.sentDate as string))
      .filter((days) => days >= 0),
  );

  const underwritingTime = average(
    snapshot.leads
      .filter((lead) => lead.underwritingEnteredAt !== null && lead.underwritingExitedAt !== null)
      .map((lead) => totalDays(lead.underwritingEnteredAt as Date, lead.underwritingExitedAt as Date))
      .filter((days) => days >= 0),
  );

  // The received-to-sent leg goes through the SHARED metric definition rather than being re-derived
  // inline (AC-080's single-home rule) — the same function the RM dashboard's turnaround reads.
  const receivedToSent = averageTurnaroundDays(
    snapshot.quotes
      .filter((quote) => quote.sentDate !== null)
      .map((quote) => ({ receivedDate: quote.leadDateReceived, sentDate: quote.sentDate as string })),
  );

  return [
    {
      key: 'received_to_assignment',
      label: 'Received → Assignment',
      averageDays: receivedToAssignment,
      targetDays: settings.slaAssignmentDays,
    },
    {
      key: 'received_to_quote_prepared',
      label: 'Received → Quote Prepared',
      averageDays: receivedToPrepared,
      targetDays: null,
    },
    { key: 'prepared_to_sent', label: 'Prepared → Sent', averageDays: preparedToSent, targetDays: null },
    { key: 'sent_to_decision', label: 'Sent → Decision', averageDays: sentToDecision, targetDays: null },
    {
      key: 'underwriting_time',
      label: 'Underwriting Time',
      averageDays: underwritingTime,
      targetDays: settings.slaUnderwritingDays,
    },
    {
      key: 'received_to_sent',
      label: 'Received → Sent (Turnaround)',
      averageDays: receivedToSent,
      targetDays: settings.slaReceivedToSentDays,
    },
  ];
}

/**
 * `BuildBreachesByStage` (:95-118).
 *
 * Each count is over the leads CURRENTLY in that stage and past their target — a statement about
 * what is breaching NOW, not about what once breached. The comparison is strictly `>` the target, so
 * a lead sitting at exactly the target day is on track, matching the alert rules.
 *
 * ================================================================================================
 * MEASURED: THE ASSIGNMENT AND RECEIVED→SENT BREACHES CLOCK FROM `created_at`, NOT `date_received`
 * ================================================================================================
 * `(now - l.CreatedAt).TotalDays` (:98, :108) — the ROW's creation instant, not the intake date the
 * lead records. The two normally coincide, and for the Assignment leg ("how long has this sat
 * unassigned since we got it") clocking from row creation is arguably the right reading. For the
 * Received→Sent leg it is more surprising, because the METRIC of the same name three functions up
 * (`received_to_sent`) genuinely measures `date_received` → `sent_date`. So a report can show an
 * average turnaround computed one way beside a breach count computed the other.
 *
 * PRESERVED AS MEASURED, NOT "FIXED". Switching to `date_received` would silently change a shipped
 * breach count — the number an Alerts SLA tab is reconciled against — and this task has no mandate
 * to redefine a metric. `reports.test.ts` seeds a lead whose `date_received` and `created_at`
 * DELIBERATELY DISAGREE (received 2 days ago, created 20), so the two columns are not substitutable
 * in the fixture and swapping them in this file fails the suite. FLAGGED for the orchestrator.
 */
function buildBreachesByStage(
  snapshot: SlaReportSnapshot,
  settings: SlaReportSettings,
  now: Date,
): readonly SlaBreachByStageDto[] {
  const assignmentBreaches = snapshot.leads.filter(
    (lead) =>
      lead.statusCanonicalKey === LEAD_STATUS_KEYS.new &&
      totalDays(lead.createdAt, now) > settings.slaAssignmentDays,
  ).length;

  const underwritingBreaches = snapshot.leads.filter(
    (lead) =>
      lead.statusCanonicalKey === LEAD_STATUS_KEYS.underwriting &&
      lead.underwritingEnteredAt !== null &&
      totalDays(lead.underwritingEnteredAt, now) > settings.slaUnderwritingDays,
  ).length;

  const receivedToSentBreaches = snapshot.leads.filter(
    (lead) =>
      isOpen(lead.reportingCategory) &&
      !lead.hasQuote &&
      totalDays(lead.createdAt, now) > settings.slaReceivedToSentDays,
  ).length;

  return [
    { stage: 'Assignment', breachCount: assignmentBreaches, targetDays: settings.slaAssignmentDays },
    {
      stage: 'Underwriting',
      breachCount: underwritingBreaches,
      targetDays: settings.slaUnderwritingDays,
    },
    {
      stage: 'Received → Sent',
      breachCount: receivedToSentBreaches,
      targetDays: settings.slaReceivedToSentDays,
    },
  ];
}

/** `BuildUnderwritingDelayQueue` (:120-135) — worst first, so the top of the printed page is the work. */
function buildUnderwritingDelayQueue(
  snapshot: SlaReportSnapshot,
  settings: SlaReportSettings,
  now: Date,
): readonly UnderwritingDelayRowDto[] {
  return snapshot.leads
    .filter(
      (lead) =>
        lead.statusCanonicalKey === LEAD_STATUS_KEYS.underwriting &&
        lead.underwritingEnteredAt !== null &&
        totalDays(lead.underwritingEnteredAt, now) > settings.slaUnderwritingDays,
    )
    .sort(
      (left, right) =>
        totalDays(right.underwritingEnteredAt as Date, now) -
        totalDays(left.underwritingEnteredAt as Date, now),
    )
    .map((lead) => ({
      leadId: lead.leadId,
      leadRef: lead.leadRef,
      clientName: lead.partyName,
      ownerName: lead.ownerName,
      daysInUnderwriting: Math.floor(totalDays(lead.underwritingEnteredAt as Date, now)),
      targetDays: settings.slaUnderwritingDays,
      // The QUOTED premium when there is one, else the estimate. A lead in underwriting with a
      // quote on it has a real number at risk; one without has only the intake estimate.
      premiumAtRisk: lead.currentQuotedPremium ?? lead.estimatedPremium,
    }));
}

/** `BuildTurnaroundByProductLine` (:137-146) — ordinal by name, matching `StringComparer.Ordinal`. */
function buildTurnaroundByProductLine(
  snapshot: SlaReportSnapshot,
): readonly TurnaroundByProductLineDto[] {
  const groups = new Map<number, { name: string; pairs: { receivedDate: string; sentDate: string }[] }>();

  for (const quote of snapshot.quotes) {
    if (quote.sentDate === null) continue;
    const existing = groups.get(quote.productLineId);
    const pair = { receivedDate: quote.leadDateReceived, sentDate: quote.sentDate };
    if (existing === undefined) {
      groups.set(quote.productLineId, { name: quote.productLineName, pairs: [pair] });
    } else {
      existing.pairs.push(pair);
    }
  }

  return [...groups.entries()]
    .map(([productLineId, group]) => ({
      productLineId,
      productLineName: group.name,
      averageTurnaroundDays: averageTurnaroundDays(group.pairs),
    }))
    .sort((left, right) =>
      left.productLineName < right.productLineName
        ? -1
        : left.productLineName > right.productLineName
          ? 1
          : 0,
    );
}

export function buildSlaTurnaroundReport(
  snapshot: SlaReportSnapshot,
  settings: SlaReportSettings,
  now: Date,
): SlaTurnaroundReportDto {
  return {
    currencyCode: settings.currencyCode,
    metrics: buildMetrics(snapshot, settings),
    breachesByStage: buildBreachesByStage(snapshot, settings, now),
    underwritingDelayQueue: buildUnderwritingDelayQueue(snapshot, settings, now),
    turnaroundByProductLine: buildTurnaroundByProductLine(snapshot),
  };
}

/** `PipelineAgingReportQueryHandler.Bucket` (:49-55). */
export function pipelineAgingReportBucket(ageDays: number): string {
  if (ageDays <= 3) return '0-3 days';
  if (ageDays <= 7) return '4-7 days';
  if (ageDays <= 14) return '8-14 days';
  return '15+ days';
}

/**
 * `PipelineAgingReportQueryHandler.Handle` (:31-47) — OPEN items only, oldest first.
 *
 * The population is the OPEN/QUOTED reporting categories, not every lead: an aging report about
 * closed business is not an aging report. Ties break on `leadId` so the printed order is stable
 * across two renders of the same data.
 */
export function buildPipelineAgingReport(
  snapshot: SlaReportSnapshot,
  settings: SlaReportSettings,
  today: string,
): PipelineAgingReportDto {
  const todayNumber = dayNumber(today);

  const rows = snapshot.leads
    .filter((lead: SlaLeadRow) => isOpen(lead.reportingCategory))
    .map((lead) => {
      const ageDays = Math.max(0, todayNumber - dayNumber(lead.dateReceived));
      return {
        leadId: lead.leadId,
        leadRef: lead.leadRef,
        clientName: lead.partyName,
        stageName: lead.statusName,
        ageDays,
        ageBucket: pipelineAgingReportBucket(ageDays),
        ownerName: lead.ownerName,
        premium: lead.currentQuotedPremium ?? lead.estimatedPremium,
      };
    })
    .sort((left, right) =>
      right.ageDays !== left.ageDays ? right.ageDays - left.ageDays : left.leadId - right.leadId,
    );

  return { currencyCode: settings.currencyCode, rows };
}
