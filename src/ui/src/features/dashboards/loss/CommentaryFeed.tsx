import { formatCompactCurrency } from '../../../components/dashboards/formatters';
import type { LossCommentaryDto } from '../lossApi';

interface CommentaryFeedProps {
  commentary: LossCommentaryDto;
  currencyCode: string;
}

/**
 * Loss Commentary feed (spec FR-59, PRD 16, T-036): the most recent lost-business notes — each shows the
 * client + product line, the one-line loss comment, the loss-reason chip (colored by its server-supplied
 * tone token, text always carrying the meaning per NFR-03), and the premium lost. Full-width.
 */
function CommentaryFeed({ commentary, currencyCode }: CommentaryFeedProps) {
  const { items } = commentary;

  return (
    <div
      data-testid="loss-commentary"
      className="qiq-card"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}
    >
      <div className="qiq-card-head" style={{ marginBottom: 0, alignItems: 'flex-start', flexDirection: 'column' }}>
        <span className="qiq-card-title">Loss Commentary</span>
        <span className="qiq-card-sub">Recent lost-business notes</span>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-2)' }}>
        {items.length === 0 && <li className="qiq-card-sub">No recent lost business.</li>}
        {items.map((item) => (
          <li
            key={item.leadId}
            data-testid="commentary-item"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto auto',
              alignItems: 'center',
              gap: 'var(--qiq-space-3)',
              padding: 'var(--qiq-space-2) 0',
              borderBottom: '1px solid var(--qiq-border-subtle)',
            }}
          >
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="qiq-kpi-label">
                {item.client} · {item.productLineName}
              </span>
              <span className="qiq-card-sub">{item.comment ?? '—'}</span>
            </span>
            <span
              data-testid="commentary-reason-chip"
              className={`qiq-chip qiq-chip--${item.lossReasonTone}`}
            >
              {item.lossReasonName}
            </span>
            <span data-testid="commentary-premium" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 84, textAlign: 'right' }}>
              {formatCompactCurrency(item.premium, currencyCode)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default CommentaryFeed;
