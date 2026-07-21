import StatusChip from '../../components/common/StatusChip';
import type { ReferenceItemDto } from '../settings/settingsApi';
import { labelForQuoteOperation } from './quoteOperations';
import { deriveQuoteReportingCategory, isQuoteClosed } from './quoteStatusCategory';
import type { QuoteAttachmentDto, QuoteDetailDto } from './quotesApi';
import AttachmentsSection from './AttachmentsSection';

interface QuoteDetailPanelProps {
  quote: QuoteDetailDto;
  currencySymbol: string;
  /** `quote_status` reference list (`listReferenceItems('quote_status')`), for resolving history entries' status ids to names; `null` while unavailable. */
  quoteStatuses: ReferenceItemDto[] | null;
  attachments: QuoteAttachmentDto[];
  maxAttachmentMb: number | null;
  canCorrectClosed: boolean;
  onAttachmentUploaded: (attachment: QuoteAttachmentDto) => void;
  onAttachmentRemoved: (attachmentId: number) => void;
  onAction: (operation: string) => void;
}

function formatMoney(value: number, currencySymbol: string): string {
  return `${currencySymbol} ${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** Formats an ISO timestamp like the lead timeline does; unset placeholder values (year <= 1) render as an em dash. */
function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() <= 1) {
    return '—';
  }
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function statusNameFor(statusId: number | null, quoteStatuses: ReferenceItemDto[] | null): string {
  if (statusId === null) {
    return '—';
  }
  return quoteStatuses?.find((status) => status.id === statusId)?.name ?? `Status #${statusId}`;
}

/**
 * Expanded quote row (spec FR-47, AC-046, T-029): field grid, version history (version/premium/note/
 * current badge), status history, attachments, and only the workflow buttons the server's
 * `availableOperations` grants for this quote's own current status (never disabled-but-visible,
 * AC-016's illegal-hidden convention). Styled on the shared design-system pieces the lead panels use:
 * `.qiq-dl` for the field grid, section-title rules, and plain tables for both histories.
 *
 * Flagged gap: the brief lists "created by/at" among the version-history columns. `QuoteVersion`
 * now carries `CreatedBy` (ReviseQuoteCommandHandler stamps it), but `QuoteVersionDto`
 * (`src/api/.../Features/Quotes/QuoteDto.cs`) still projects only `CreatedAt`, so the column renders
 * "—" rather than a fabricated value. Recommended follow-up: project `createdBy` (resolved to a
 * display name) on `QuoteVersionDto`.
 */
function QuoteDetailPanel({
  quote,
  currencySymbol,
  quoteStatuses,
  attachments,
  maxAttachmentMb,
  canCorrectClosed,
  onAttachmentUploaded,
  onAttachmentRemoved,
  onAction,
}: QuoteDetailPanelProps) {
  const reportingCategory = deriveQuoteReportingCategory(quote.statusCanonicalKey);
  const closed = isQuoteClosed(quote.statusCanonicalKey);
  const currentVersion = quote.versions.find((version) => version.isCurrent) ?? quote.versions[quote.versions.length - 1] ?? null;

  return (
    <div data-testid="quote-detail-panel" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-5)', padding: 'var(--qiq-space-3) 0' }}>
      <dl data-testid="quote-field-grid" className="qiq-dl">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusChip label={quote.statusName} category={reportingCategory} />
          </dd>
        </div>
        <div>
          <dt>Product line</dt>
          <dd data-testid="quote-product-line">{quote.productLineName}</dd>
        </div>
        <div>
          <dt>Cover type</dt>
          <dd data-testid="quote-cover-type">{quote.coverTypeName}</dd>
        </div>
        <div>
          <dt>Prepared date</dt>
          <dd data-testid="quote-prepared-date">{quote.preparedDate}</dd>
        </div>
        <div>
          <dt>Sent date</dt>
          <dd data-testid="quote-sent-date">{quote.sentDate ?? '—'}</dd>
        </div>
        <div>
          <dt>Valid until</dt>
          <dd data-testid="quote-valid-until">{quote.validUntil ?? '—'}</dd>
        </div>
        <div>
          <dt>Current premium</dt>
          <dd data-testid="quote-current-premium">{currentVersion ? formatMoney(currentVersion.quotedPremium, currencySymbol) : '—'}</dd>
        </div>
        {quote.notes && (
          <div>
            <dt>Notes</dt>
            <dd data-testid="quote-notes">{quote.notes}</dd>
          </div>
        )}
        {closed && quote.decisionDate && (
          <div>
            <dt>Decision date</dt>
            <dd data-testid="quote-decision-date">{formatDateTime(quote.decisionDate)}</dd>
          </div>
        )}
        {reportingCategory === 'won' && quote.boundPremium !== null && (
          <div>
            <dt>Bound premium</dt>
            <dd data-testid="quote-bound-premium">{formatMoney(quote.boundPremium, currencySymbol)}</dd>
          </div>
        )}
        {reportingCategory === 'lost' && (
          <>
            <div>
              <dt>Competitor</dt>
              <dd data-testid="quote-competitor">{quote.competitor ?? '—'}</dd>
            </div>
            <div>
              <dt>Loss comments</dt>
              <dd data-testid="quote-loss-comments">{quote.lossComments ?? '—'}</dd>
            </div>
          </>
        )}
        {reportingCategory === 'withdrawn' && (
          <div>
            <dt>Withdrawal note</dt>
            <dd data-testid="quote-withdrawal-note">{quote.withdrawalNote ?? '—'}</dd>
          </div>
        )}
      </dl>

      <section>
        <h4 className="qiq-form-section-title" style={{ marginBottom: 'var(--qiq-space-3)' }}>
          Version history
        </h4>
        <div className="qiq-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th className="qiq-num">Premium</th>
                <th>Note</th>
                <th>Created by</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody data-testid="version-history">
              {quote.versions.map((version) => (
                <tr key={version.id} data-testid="version-history-entry">
                  <td data-testid="version-number" className="qiq-mono">
                    v{version.versionNo}
                  </td>
                  <td data-testid="version-premium" className="qiq-num">
                    {formatMoney(version.quotedPremium, currencySymbol)}
                  </td>
                  <td data-testid="version-note">{version.revisionNote ?? version.termsNotes ?? '—'}</td>
                  <td data-testid="version-created-by">—</td>
                  <td data-testid="version-created-at" style={{ whiteSpace: 'nowrap', color: 'var(--qiq-text-secondary)' }}>
                    {formatDateTime(version.createdAt)}
                  </td>
                  <td>
                    {version.isCurrent && (
                      <span data-testid="version-current-badge" className="qiq-chip qiq-chip--accent" title="Current version">
                        Current
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h4 className="qiq-form-section-title" style={{ marginBottom: 'var(--qiq-space-3)' }}>
          Status history
        </h4>
        {quote.history.length === 0 ? (
          <p className="qiq-field-hint">No status changes yet.</p>
        ) : (
          <div className="qiq-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Transition</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody data-testid="quote-status-history">
                {quote.history.map((entry, index) => (
                  <tr key={`${entry.operation}-${entry.actedAt}-${index}`} data-testid="quote-status-history-entry">
                    <td data-testid="quote-status-history-at" style={{ whiteSpace: 'nowrap', color: 'var(--qiq-text-secondary)' }}>
                      {formatDateTime(entry.actedAt)}
                    </td>
                    <td data-testid="quote-status-history-operation" style={{ fontWeight: 600 }}>
                      {labelForQuoteOperation(entry.operation)}
                    </td>
                    <td data-testid="quote-status-history-transition">
                      {statusNameFor(entry.previousStatusId, quoteStatuses)} → {statusNameFor(entry.newStatusId, quoteStatuses)}
                    </td>
                    <td data-testid="quote-status-history-actor">{entry.actedBy !== null ? `User #${entry.actedBy}` : 'System'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AttachmentsSection
        quoteId={quote.id}
        attachments={attachments}
        maxAttachmentMb={maxAttachmentMb}
        isClosedQuote={closed}
        canCorrectClosed={canCorrectClosed}
        onUploaded={onAttachmentUploaded}
        onRemoved={onAttachmentRemoved}
      />

      <div data-testid="quote-actions" style={{ display: 'flex', gap: 'var(--qiq-space-3)', flexWrap: 'wrap' }}>
        {quote.availableOperations.map((operation) => (
          <button key={operation} type="button" data-testid={`quote-action-${operation}`} onClick={() => onAction(operation)}>
            {labelForQuoteOperation(operation)}
          </button>
        ))}
      </div>
    </div>
  );
}

export default QuoteDetailPanel;
