import { useState } from 'react';
import Icon from '../common/Icon';
import { useTenantCurrency } from './useTenantCurrency';

function formatTimestamp(date: Date): string {
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Persistent footer (spec FR-52, PRD 12.2, UI Standards §11): copyright, "All amounts in
 * {tenant display currency}" (A-3, AC-074), and the data-currency timestamp with a refresh control.
 */
function Footer() {
  const currencyCode = useTenantCurrency();
  const [lastRefreshed, setLastRefreshed] = useState(() => new Date());

  return (
    <footer data-testid="footer" className="qiq-footer">
      <span>{'©'} QuoteIQ</span>
      <span data-testid="footer-currency">All amounts in {currencyCode}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
        <span data-testid="footer-data-timestamp">Data as of {formatTimestamp(lastRefreshed)}</span>
        <button
          type="button"
          className="qiq-btn qiq-btn--ghost qiq-btn--sm"
          data-testid="footer-refresh"
          aria-label="Refresh data"
          onClick={() => setLastRefreshed(new Date())}
        >
          <Icon name="refresh" size={14} />
        </button>
      </span>
    </footer>
  );
}

export default Footer;
