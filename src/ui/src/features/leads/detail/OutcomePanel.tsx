import type { LeadDetailDto } from '../leadsApi';

function formatCurrency(value: number | null | undefined, currencyCode: string): string {
  if (value == null) {
    return '—';
  }
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currencyCode} ${value.toLocaleString()}`;
  }
}

interface OutcomePanelProps {
  lead: LeadDetailDto;
  outcomeCategory: 'won' | 'lost' | 'expired' | 'withdrawn';
  currencyCode: string;
}

/**
 * Lead Detail's Outcome panel (spec FR-44, PRD 12.5, AC-043): renders only when the lead is closed
 * (a terminal reporting category), showing the outcome status, decision date, and — for Won — bound
 * premium, or — for Lost — reason/competitor/comments, plus who closed it.
 *
 * Flagged gap (T-028 final report, see `LeadDetailDto`'s own doc comment): `GetLeadQueryHandler`
 * does not project `decisionDate`/`lostReasonName`/`competitor`/`competitorPremium`/`lossComments`/
 * `closedByName`/`boundPremium` today, even though the `Lead` entity already carries most of them
 * (T-019 sets them on Mark lost; bound premium is T-020/T-029's quote-level field). Every row below
 * degrades to "—" until that gap is closed — this panel is written to pick the real values up the
 * moment `LeadDto` projects them, with no further UI change needed.
 */
function OutcomePanel({ lead, outcomeCategory, currencyCode }: OutcomePanelProps) {
  return (
    <section data-testid="outcome-panel" className="qiq-card">
      <div className="qiq-card-head">
        <h3 className="qiq-card-title">Outcome</h3>
      </div>
      <dl className="qiq-dl">
        <div>
          <dt>Status</dt>
          <dd data-testid="outcome-status">{lead.statusName}</dd>
        </div>
        <div>
          <dt>Decision date</dt>
          <dd data-testid="outcome-decision-date">{lead.decisionDate ?? '—'}</dd>
        </div>

        {outcomeCategory === 'won' && (
          <div>
            <dt>Bound premium</dt>
            <dd data-testid="outcome-bound-premium">{formatCurrency(lead.boundPremium, currencyCode)}</dd>
          </div>
        )}

        {outcomeCategory === 'lost' && (
          <>
            <div>
              <dt>Lost reason</dt>
              <dd data-testid="outcome-lost-reason">{lead.lostReasonName ?? '—'}</dd>
            </div>
            <div>
              <dt>Competitor</dt>
              <dd data-testid="outcome-competitor">{lead.competitor ?? '—'}</dd>
            </div>
            <div>
              <dt>Competitor premium</dt>
              <dd data-testid="outcome-competitor-premium">{formatCurrency(lead.competitorPremium, currencyCode)}</dd>
            </div>
            <div>
              <dt>Comments</dt>
              <dd data-testid="outcome-loss-comments">{lead.lossComments ?? '—'}</dd>
            </div>
          </>
        )}

        <div>
          <dt>Closed by</dt>
          <dd data-testid="outcome-closed-by">{lead.closedByName ?? '—'}</dd>
        </div>
      </dl>
    </section>
  );
}

export default OutcomePanel;
