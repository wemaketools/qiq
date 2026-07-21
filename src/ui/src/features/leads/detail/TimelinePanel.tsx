import type { TimelineEntryDto } from '../leadsApi';

const TYPE_LABELS: Record<TimelineEntryDto['type'], { label: string; chipClass: string }> = {
  status: { label: 'Status change', chipClass: 'qiq-chip--open' },
  quote_status: { label: 'Quote', chipClass: 'qiq-chip--accent' },
  follow_up: { label: 'Follow-up', chipClass: 'qiq-chip--success' },
  note: { label: 'Note', chipClass: 'qiq-chip--neutral' },
};

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

interface NextFollowUpBannerProps {
  nextFollowUpDate: string | null;
  isOverdue: boolean;
  onLogFollowUp: () => void;
}

/** Prominent next-follow-up banner above the timeline (spec FR-44: "prominent next-follow-up and Overdue chip"), red-styled + an "Overdue" chip once past due. */
function NextFollowUpBanner({ nextFollowUpDate, isOverdue, onLogFollowUp }: NextFollowUpBannerProps) {
  return (
    <div
      data-testid="next-follow-up-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--qiq-space-3)',
        padding: 'var(--qiq-space-3) var(--qiq-space-4)',
        borderRadius: 'var(--qiq-radius-card)',
        marginBottom: 'var(--qiq-space-4)',
        background: isOverdue ? 'var(--qiq-danger-soft)' : 'var(--qiq-info-soft)',
        color: isOverdue ? 'var(--qiq-danger)' : 'var(--qiq-info)',
        fontWeight: 550,
        fontSize: '13px',
      }}
    >
      <span>
        {nextFollowUpDate ? `Next follow-up: ${nextFollowUpDate}` : 'No follow-up scheduled'}
        {isOverdue && (
          <span
            data-testid="overdue-chip"
            className="qiq-chip qiq-chip--danger"
            style={{ marginLeft: 'var(--qiq-space-2)', border: '1px solid var(--qiq-danger)' }}
          >
            Overdue
          </span>
        )}
      </span>
      <button type="button" data-testid="log-follow-up-button" onClick={onLogFollowUp}>
        Log follow-up
      </button>
    </div>
  );
}

interface TimelinePanelProps {
  entries: TimelineEntryDto[];
  totalCount: number;
  loading: boolean;
  loadingMore: boolean;
  nextFollowUpDate: string | null;
  isNextFollowUpOverdue: boolean;
  onLoadMore: () => void;
  onLogFollowUp: () => void;
}

/**
 * Lead Detail's combined activity timeline (spec FR-44, T-022's `GetLeadTimelineQuery`, T-028):
 * a table (When / Type / Activity / Detail / Quote / By), newest first (the order the backend
 * already returns them in — this component never re-sorts), a Load more control below the list,
 * and the `NextFollowUpBanner` above it.
 */
function TimelinePanel({ entries, totalCount, loading, loadingMore, nextFollowUpDate, isNextFollowUpOverdue, onLoadMore, onLogFollowUp }: TimelinePanelProps) {
  return (
    <section data-testid="timeline-panel" className="qiq-card">
      <NextFollowUpBanner nextFollowUpDate={nextFollowUpDate} isOverdue={isNextFollowUpOverdue} onLogFollowUp={onLogFollowUp} />

      <div className="qiq-card-head">
        <h3 className="qiq-card-title">Activity</h3>
      </div>

      {loading && <p data-testid="timeline-loading">Loading…</p>}

      {!loading && entries.length === 0 && <p data-testid="timeline-empty">No activity yet.</p>}

      {!loading && entries.length > 0 && (
        <div className="qiq-table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Activity</th>
                <th>Detail</th>
                <th>Quote</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody data-testid="timeline-entries">
              {entries.map((entry, index) => (
                <tr key={`${entry.type}-${entry.at}-${index}`} data-testid="timeline-entry" data-entry-type={entry.type}>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--qiq-text-secondary)' }}>
                    <time data-testid="timeline-entry-at" dateTime={entry.at}>
                      {formatDateTime(entry.at)}
                    </time>
                  </td>
                  <td>
                    <span data-testid={`timeline-entry-icon-${entry.type}`} className={`qiq-chip ${TYPE_LABELS[entry.type].chipClass}`}>
                      {TYPE_LABELS[entry.type].label}
                    </span>
                  </td>
                  <td data-testid="timeline-entry-title" style={{ fontWeight: 600 }}>
                    {entry.title}
                  </td>
                  <td data-testid="timeline-entry-detail">{entry.detail ?? '—'}</td>
                  <td data-testid="timeline-entry-quote-ref" className="qiq-mono">
                    {entry.quoteRef ?? '—'}
                  </td>
                  <td data-testid="timeline-entry-actor">{entry.actorName ?? 'System'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && entries.length < totalCount && (
        <button
          type="button"
          data-testid="timeline-load-more"
          disabled={loadingMore}
          onClick={onLoadMore}
          style={{ marginTop: 'var(--qiq-space-3)' }}
        >
          Load more
        </button>
      )}
    </section>
  );
}

export default TimelinePanel;
