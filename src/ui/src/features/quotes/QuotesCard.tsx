import { Fragment, forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import { useToast } from '../../components/common/Toast';
import StatusChip from '../../components/common/StatusChip';
import type { NormalizedError } from '../../api/client';
import type { LeadDetailDto } from '../leads/leadsApi';
import type { BusinessAssignmentsDto, ReferenceItemDto } from '../settings/settingsApi';
import NewQuoteModal from './NewQuoteModal';
import QuoteDetailPanel from './QuoteDetailPanel';
import QuoteAssignDialog from './dialogs/QuoteAssignDialog';
import SendQuoteDialog from './dialogs/SendQuoteDialog';
import ReviseQuoteDialog from './dialogs/ReviseQuoteDialog';
import MarkWonDialog from './dialogs/MarkWonDialog';
import MarkQuoteLostDialog from './dialogs/MarkQuoteLostDialog';
import WithdrawQuoteDialog from './dialogs/WithdrawQuoteDialog';
import { deriveQuoteReportingCategory } from './quoteStatusCategory';
import {
  QUOTE_OPERATION_CODES,
  assignQuote,
  createQuote,
  getQuote,
  listQuotesForLead,
  markQuoteLost,
  markQuoteWon,
  reviseQuote,
  sendQuote,
  setCurrentQuote,
  withdrawQuote,
  type CreateQuotePayload,
  type QuoteAttachmentDto,
  type QuoteAssignmentPayload,
  type QuoteDetailDto,
  type QuoteListItemDto,
} from './quotesApi';

/** Imperative handle so `LeadDetailPage`'s header primary action (spec: "draft-quote-exists -> Send quote") can trigger this card's own Send dialog without hoisting all quote-dialog state up to the page. */
export interface QuotesCardHandle {
  openSendDialogForDraft: () => void;
}

interface QuotesCardProps {
  lead: LeadDetailDto;
  currencySymbol: string;
  /** Tenant's `quoteExpiryAlertDays` (spec A-4), for the amber valid-until threshold; `null` while unavailable (falls back to no amber highlighting, red-past-due still applies). */
  quoteExpiryAlertDays: number | null;
  maxAttachmentMb: number | null;
  roles: BusinessAssignmentsDto | null;
  lostReasons: ReferenceItemDto[] | null;
  quoteStatuses: ReferenceItemDto[] | null;
  productLineOptions: ReferenceItemDto[] | null;
  coverTypeOptions: ReferenceItemDto[] | null;
  isLeadClosed: boolean;
  /** Alerts-center deep-link (T-037): the alerting quote to highlight/expand on load (spec FR-62); `null`/absent when opened normally. */
  highlightQuoteId?: number | null;
  onQuotesLoaded?: (quotes: QuoteListItemDto[]) => void;
  /** After ANY quote operation succeeds (spec T-029 brief): the lead's own status may have cascaded, so the parent refetches the lead + timeline in place (no full reload). */
  onQuoteMutated: () => void;
}

const OPEN_QUOTE_CANONICAL_KEYS = new Set(['draft', 'sent', 'revised']);
const MS_PER_DAY = 86_400_000;

function formatMoney(value: number, currencySymbol: string): string {
  return `${currencySymbol} ${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** Amber within the tenant's expiry-alert window, red once past — `undefined` when `validUntil` is unset (spec FR-44). */
function validUntilTone(validUntil: string | null, alertDays: number | null): 'red' | 'amber' | undefined {
  if (!validUntil) {
    return undefined;
  }
  const daysRemaining = Math.floor((new Date(validUntil).getTime() - Date.now()) / MS_PER_DAY);
  if (daysRemaining < 0) {
    return 'red';
  }
  if (alertDays !== null && daysRemaining <= alertDays) {
    return 'amber';
  }
  return undefined;
}

function currentVersionNo(quote: QuoteDetailDto | null): string {
  if (!quote) {
    return '—';
  }
  const current = quote.versions.find((version) => version.isCurrent) ?? quote.versions[quote.versions.length - 1];
  return current ? `v${current.versionNo}` : '—';
}

/**
 * Quotes card, worked entirely inside Lead Detail (spec FR-44/FR-45, PRD 12.7, T-029): columns per
 * FR-44 (ref monospace, version, status chip, quoted premium, prepared/sent dates, valid-until with
 * amber/red tone, current marker with a set-current action per PRD 7.3, row expansion into
 * `QuoteDetailPanel`), + New Quote hidden when the lead is closed, and the FR-44 empty state.
 */
const QuotesCard = forwardRef<QuotesCardHandle, QuotesCardProps>(function QuotesCard(
  {
    lead,
    currencySymbol,
    quoteExpiryAlertDays,
    maxAttachmentMb,
    roles,
    lostReasons,
    quoteStatuses,
    productLineOptions,
    coverTypeOptions,
    isLeadClosed,
    highlightQuoteId,
    onQuotesLoaded,
    onQuoteMutated,
  },
  ref,
) {
  const canCreate = useAppSelector(selectHasPermission(PermissionCodes.QuotesCreate));
  const canSetCurrent = useAppSelector(selectHasPermission(PermissionCodes.QuotesSetCurrent));
  const canCorrectClosed = useAppSelector(selectHasPermission(PermissionCodes.QuotesCorrectClosed));
  const { showSuccess } = useToast();

  const [quotes, setQuotes] = useState<QuoteListItemDto[]>([]);
  const [loading, setLoading] = useState(true);

  const [expandedQuoteId, setExpandedQuoteId] = useState<number | null>(null);
  const [expandedQuote, setExpandedQuote] = useState<QuoteDetailDto | null>(null);
  const [expandedLoading, setExpandedLoading] = useState(false);

  // Flagged gap (see `quotesApi.ts`'s `QuoteAttachmentDto` doc comment): there is no
  // `GET /quotes/{id}/attachments` endpoint, so this card tracks attachments client-side per quote id
  // for the duration of the page session (populated by upload responses, pruned by remove responses).
  // A fresh page load / lead reload cannot show attachments uploaded in an earlier session.
  const [attachmentsByQuoteId, setAttachmentsByQuoteId] = useState<Record<number, QuoteAttachmentDto[]>>({});

  const [newQuoteOpen, setNewQuoteOpen] = useState(false);
  const [activeDialog, setActiveDialog] = useState<string | null>(null);
  const [dialogQuoteId, setDialogQuoteId] = useState<number | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  function loadQuotes(): void {
    setLoading(true);
    listQuotesForLead(lead.id)
      .then((result) => {
        setQuotes(result);
        onQuotesLoaded?.(result);
      })
      .catch(() => setQuotes([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadQuotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the lead identity changes.
  }, [lead.id]);

  // Alerts-center deep-link (T-037, spec FR-62): once quotes load, auto-expand the alerting quote so
  // it is visibly highlighted. No-op when no `highlightQuoteId` is present or it matches no quote.
  useEffect(() => {
    if (highlightQuoteId == null || quotes.length === 0) {
      return;
    }
    const match = quotes.find((quote) => quote.id === highlightQuoteId);
    if (match && expandedQuoteId !== match.id) {
      setExpandedQuoteId(match.id);
      setExpandedQuote(null);
      reloadExpanded(match.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run when quotes load or the highlight target changes.
  }, [highlightQuoteId, quotes]);

  function reloadExpanded(quoteId: number): void {
    setExpandedLoading(true);
    getQuote(quoteId)
      .then(setExpandedQuote)
      .catch(() => setExpandedQuote(null))
      .finally(() => setExpandedLoading(false));
  }

  function toggleExpand(quoteId: number): void {
    if (expandedQuoteId === quoteId) {
      setExpandedQuoteId(null);
      setExpandedQuote(null);
      return;
    }
    setExpandedQuoteId(quoteId);
    setExpandedQuote(null);
    reloadExpanded(quoteId);
  }

  function openDialogFor(quoteId: number, op: string): void {
    setDialogQuoteId(quoteId);
    setActiveDialog(op);
    setDialogError(null);
  }

  function closeDialog(): void {
    setActiveDialog(null);
    setDialogQuoteId(null);
    setDialogError(null);
  }

  useImperativeHandle(
    ref,
    () => ({
      openSendDialogForDraft: () => {
        const draft = quotes.find((q) => q.statusCanonicalKey === 'draft' && q.isCurrent) ?? quotes.find((q) => q.statusCanonicalKey === 'draft');
        if (draft) {
          openDialogFor(draft.id, QUOTE_OPERATION_CODES.Send);
        }
      },
    }),
    [quotes],
  );

  function handleOpSuccess(updated: QuoteDetailDto, message: string): void {
    setDialogBusy(false);
    setDialogError(null);
    closeDialog();
    showSuccess(message);
    loadQuotes();
    onQuoteMutated();
    if (expandedQuoteId === updated.id) {
      setExpandedQuote(updated);
    }
  }

  function handleOpError(err: unknown): void {
    setDialogBusy(false);
    setDialogError((err as NormalizedError).title ?? 'Unable to complete this action.');
  }

  function handleSetCurrent(quoteId: number): void {
    setCurrentQuote(quoteId)
      .then((updated) => {
        showSuccess(`Quote ${updated.quoteRef} is now the current quote`);
        loadQuotes();
        onQuoteMutated();
        if (expandedQuoteId === quoteId) {
          setExpandedQuote(updated);
        }
      })
      .catch(() => {
        // Silent: the row's own state is unchanged and the user can retry; a full inline error slot
        // for a lightweight list-level action is out of this card's scope.
      });
  }

  function handleCreateQuote(payload: CreateQuotePayload): void {
    setDialogBusy(true);
    createQuote(lead.id, payload)
      .then((created) => {
        setDialogBusy(false);
        setDialogError(null);
        setNewQuoteOpen(false);
        showSuccess(`Quote ${created.quoteRef} saved as draft`);
        loadQuotes();
        onQuoteMutated();
      })
      .catch((err: unknown) => {
        setDialogBusy(false);
        setDialogError((err as NormalizedError).title ?? 'Unable to create this quote.');
      });
  }

  async function handleAssignConfirm(assignments: QuoteAssignmentPayload[], comment: string | null): Promise<void> {
    if (dialogQuoteId === null) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await assignQuote(dialogQuoteId, assignments, comment);
      handleOpSuccess(updated, `Quote ${updated.quoteRef} assignments updated`);
    } catch (err) {
      handleOpError(err);
    }
  }

  async function handleSendConfirm(sentDate: string, validUntil: string, nextFollowUpDate: string): Promise<void> {
    if (dialogQuoteId === null) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await sendQuote(dialogQuoteId, sentDate, validUntil, nextFollowUpDate);
      handleOpSuccess(updated, `Quote ${updated.quoteRef} sent`);
    } catch (err) {
      handleOpError(err);
    }
  }

  async function handleReviseConfirm(newQuotedPremium: number | null, termsNotes: string | null, revisionNote: string): Promise<void> {
    if (dialogQuoteId === null) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await reviseQuote(dialogQuoteId, newQuotedPremium, termsNotes, revisionNote);
      handleOpSuccess(updated, `Quote ${updated.quoteRef} revised`);
    } catch (err) {
      handleOpError(err);
    }
  }

  async function handleMarkWonConfirm(boundPremium: number | null, decisionDate: string | null): Promise<void> {
    if (dialogQuoteId === null) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await markQuoteWon(dialogQuoteId, boundPremium, decisionDate);
      handleOpSuccess(updated, `Quote ${updated.quoteRef} marked Won`);
    } catch (err) {
      handleOpError(err);
    }
  }

  async function handleMarkLostConfirm(
    lostReasonId: number,
    competitor: string | null,
    competitorPremium: number | null,
    lossComments: string | null,
    alsoCloseLead: boolean,
  ): Promise<void> {
    if (dialogQuoteId === null) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await markQuoteLost(dialogQuoteId, lostReasonId, competitor, competitorPremium, lossComments, alsoCloseLead);
      handleOpSuccess(updated, `Quote ${updated.quoteRef} marked Lost`);
    } catch (err) {
      handleOpError(err);
    }
  }

  async function handleWithdrawConfirm(withdrawalNote: string): Promise<void> {
    if (dialogQuoteId === null) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await withdrawQuote(dialogQuoteId, withdrawalNote);
      handleOpSuccess(updated, `Quote ${updated.quoteRef} withdrawn`);
    } catch (err) {
      handleOpError(err);
    }
  }

  const dialogQuoteItem = dialogQuoteId !== null ? (quotes.find((q) => q.id === dialogQuoteId) ?? null) : null;
  const hasOtherOpenQuotes =
    dialogQuoteId !== null &&
    quotes.some((q) => q.id !== dialogQuoteId && OPEN_QUOTE_CANONICAL_KEYS.has(q.statusCanonicalKey ?? ''));

  const defaultProductLineId = lead.productLineId;
  const defaultCoverTypeId = lead.coverTypeId;

  return (
    <section data-testid="quotes-card" className="qiq-card">
      <div className="qiq-card-head">
        <h3 className="qiq-card-title">Quotes</h3>
        {!isLeadClosed && canCreate && (
          <button type="button" className="qiq-btn qiq-btn--primary" data-testid="new-quote-button" onClick={() => setNewQuoteOpen(true)}>
            + New Quote
          </button>
        )}
      </div>

      {loading && <p>Loading quotes…</p>}

      {!loading && quotes.length === 0 && (
        <p data-testid="quotes-empty-state">No quotes yet — create one when formal terms are ready.</p>
      )}

      {!loading && quotes.length > 0 && (
        <div className="qiq-table-wrap">
        <table data-testid="quotes-table">
          <thead>
            <tr>
              <th>Quote ref</th>
              <th>Product</th>
              <th>Version</th>
              <th>Status</th>
              <th className="qiq-num">Quoted premium</th>
              <th>Prepared</th>
              <th>Sent</th>
              <th>Valid until</th>
              <th>Current</th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((quote) => {
              const category = deriveQuoteReportingCategory(quote.statusCanonicalKey);
              const tone = validUntilTone(quote.validUntil, quoteExpiryAlertDays);
              const isExpanded = expandedQuoteId === quote.id;

              return (
                <Fragment key={quote.id}>
                  <tr
                    data-testid="quote-row"
                    data-quote-ref={quote.quoteRef}
                    data-highlighted={highlightQuoteId === quote.id ? 'true' : undefined}
                    onClick={() => toggleExpand(quote.id)}
                    className="qiq-row-clickable"
                  >
                    <td data-testid="quote-ref-cell" className="qiq-mono">
                      {quote.quoteRef}
                    </td>
                    <td data-testid="quote-product-cell">{quote.productLineName || '—'}</td>
                    <td data-testid="quote-version-cell">{isExpanded ? currentVersionNo(expandedQuote) : '—'}</td>
                    <td>
                      <StatusChip label={quote.statusName} category={category} />
                    </td>
                    <td data-testid="quote-premium-cell" className="qiq-num">{formatMoney(quote.currentQuotedPremium, currencySymbol)}</td>
                    <td data-testid="quote-prepared-cell">{quote.preparedDate}</td>
                    <td data-testid="quote-sent-cell">{quote.sentDate ?? '—'}</td>
                    <td data-testid="quote-valid-until-cell" data-tone={tone}>
                      {quote.validUntil ?? '—'}
                    </td>
                    <td>
                      {quote.isCurrent ? (
                        <span data-testid="quote-current-marker">Current</span>
                      ) : (
                        canSetCurrent && (
                          <button
                            type="button"
                            data-testid="set-current-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleSetCurrent(quote.id);
                            }}
                          >
                            Set current
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={9} style={{ background: 'var(--qiq-surface-inset)', padding: 'var(--qiq-space-4) var(--qiq-space-5)' }}>
                        {expandedLoading && <p>Loading quote…</p>}
                        {!expandedLoading && expandedQuote && (
                          <QuoteDetailPanel
                            quote={expandedQuote}
                            currencySymbol={currencySymbol}
                            quoteStatuses={quoteStatuses}
                            attachments={attachmentsByQuoteId[quote.id] ?? []}
                            maxAttachmentMb={maxAttachmentMb}
                            canCorrectClosed={canCorrectClosed}
                            onAttachmentUploaded={(attachment) =>
                              setAttachmentsByQuoteId((current) => ({
                                ...current,
                                [quote.id]: [...(current[quote.id] ?? []), attachment],
                              }))
                            }
                            onAttachmentRemoved={(attachmentId) =>
                              setAttachmentsByQuoteId((current) => ({
                                ...current,
                                [quote.id]: (current[quote.id] ?? []).filter((a) => a.id !== attachmentId),
                              }))
                            }
                            onAction={(op) => openDialogFor(quote.id, op)}
                          />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      <NewQuoteModal
        open={newQuoteOpen}
        leadDateReceived={lead.dateReceived}
        defaultProductLineId={defaultProductLineId}
        defaultCoverTypeId={defaultCoverTypeId}
        productLineOptions={productLineOptions}
        coverTypeOptions={coverTypeOptions}
        currencySymbol={currencySymbol}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={handleCreateQuote}
        onCancel={() => {
          setNewQuoteOpen(false);
          setDialogError(null);
        }}
      />

      <QuoteAssignDialog
        open={activeDialog === QUOTE_OPERATION_CODES.Assign}
        quoteRef={dialogQuoteItem?.quoteRef ?? ''}
        partyName={lead.partyName}
        roles={roles}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(assignments, comment) => void handleAssignConfirm(assignments, comment)}
        onCancel={closeDialog}
      />

      <SendQuoteDialog
        open={activeDialog === QUOTE_OPERATION_CODES.Send}
        quoteRef={dialogQuoteItem?.quoteRef ?? ''}
        partyName={lead.partyName}
        quotedPremium={dialogQuoteItem?.currentQuotedPremium ?? null}
        currencySymbol={currencySymbol}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(sentDate, validUntil, nextFollowUpDate) => void handleSendConfirm(sentDate, validUntil, nextFollowUpDate)}
        onCancel={closeDialog}
      />

      <ReviseQuoteDialog
        open={activeDialog === QUOTE_OPERATION_CODES.Revise}
        quoteRef={dialogQuoteItem?.quoteRef ?? ''}
        partyName={lead.partyName}
        currentQuotedPremium={dialogQuoteItem?.currentQuotedPremium ?? null}
        currencySymbol={currencySymbol}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(premium, terms, note) => void handleReviseConfirm(premium, terms, note)}
        onCancel={closeDialog}
      />

      <MarkWonDialog
        open={activeDialog === QUOTE_OPERATION_CODES.MarkWon}
        quoteRef={dialogQuoteItem?.quoteRef ?? ''}
        partyName={lead.partyName}
        quotedPremium={dialogQuoteItem?.currentQuotedPremium ?? null}
        currencySymbol={currencySymbol}
        hasOtherOpenQuotes={hasOtherOpenQuotes}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(boundPremium, decisionDate) => void handleMarkWonConfirm(boundPremium, decisionDate)}
        onCancel={closeDialog}
      />

      <MarkQuoteLostDialog
        open={activeDialog === QUOTE_OPERATION_CODES.MarkLost}
        quoteRef={dialogQuoteItem?.quoteRef ?? ''}
        partyName={lead.partyName}
        lostReasons={lostReasons}
        currencySymbol={currencySymbol}
        hasOtherOpenQuotes={hasOtherOpenQuotes}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(reasonId, competitor, competitorPremium, comments, alsoCloseLead) =>
          void handleMarkLostConfirm(reasonId, competitor, competitorPremium, comments, alsoCloseLead)
        }
        onCancel={closeDialog}
      />

      <WithdrawQuoteDialog
        open={activeDialog === QUOTE_OPERATION_CODES.Withdraw}
        quoteRef={dialogQuoteItem?.quoteRef ?? ''}
        partyName={lead.partyName}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(note) => void handleWithdrawConfirm(note)}
        onCancel={closeDialog}
      />
    </section>
  );
});

export default QuotesCard;
