import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import { useTenantCurrency, useTenantCurrencySymbol } from '../../components/shell/useTenantCurrency';
import { useToast } from '../../components/common/Toast';
import ErrorBanner from '../../components/common/ErrorBanner';
import StatusChip from '../../components/common/StatusChip';
import type { NormalizedError } from '../../api/client';
import { getParty, type PartyDto } from '../parties/partiesApi';
import {
  fetchBusinessAssignments,
  fetchFullBusinessRules,
  listReferenceItems,
  type BusinessAssignmentsDto,
  type ReferenceItemDto,
} from '../settings/settingsApi';
import { deriveLeadReportingCategory } from './leadStatusCategory';
import {
  LEAD_OPERATION_CODES,
  approvePricing,
  assignLead,
  getLead,
  getLeadTimeline,
  logFollowUp,
  markLeadLost,
  rejectPricing,
  reopenLead,
  requestPricingApproval,
  sendLeadToUnderwriting,
  startLeadInformationGathering,
  startLeadNegotiation,
  startLeadPricing,
  withdrawLead,
  type LeadAssignmentPayload,
  type LeadDetailDto,
  type TimelineEntryDto,
} from './leadsApi';
import SummaryPanel from './detail/SummaryPanel';
import TimelinePanel from './detail/TimelinePanel';
import OutcomePanel from './detail/OutcomePanel';
import MoreActionsMenu from './detail/MoreActionsMenu';
import QuotesCard, { type QuotesCardHandle } from '../quotes/QuotesCard';
import type { QuoteListItemDto } from '../quotes/quotesApi';
import { labelForOperation, moreActionsOperations, resolvePrimaryOperation } from './detail/leadOperations';
import AssignDialog from './dialogs/AssignDialog';
import SendToUnderwritingDialog from './dialogs/SendToUnderwritingDialog';
import RequestPricingApprovalDialog from './dialogs/RequestPricingApprovalDialog';
import ApproveRejectPricingDialog from './dialogs/ApproveRejectPricingDialog';
import LogFollowUpDialog from './dialogs/LogFollowUpDialog';
import MarkLostDialog from './dialogs/MarkLostDialog';
import WithdrawDialog from './dialogs/WithdrawDialog';
import ReopenDialog from './dialogs/ReopenDialog';
import SimpleNoteDialog from './dialogs/SimpleNoteDialog';

interface ReferenceOption {
  id: number;
  name: string;
}

function toReferenceOptions(items: ReferenceItemDto[]): ReferenceOption[] {
  return items.map((item) => ({ id: item.id, name: item.name }));
}

function initials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

function ageDaysFor(dateReceived: string): number {
  const receivedMs = new Date(dateReceived).getTime();
  return Math.max(0, Math.floor((Date.now() - receivedMs) / 86_400_000));
}

const TERMINAL_CATEGORIES = new Set(['won', 'lost', 'expired', 'withdrawn']);

/** Not a `LeadOperationCode` — a UI-only marker for the header's "Send quote" primary action (spec: "draft-quote-exists -> Send", T-029), which routes to `QuotesCardHandle.openSendDialogForDraft()` rather than a lead-level workflow dialog. */
const SEND_QUOTE_PSEUDO_OP = 'send-quote';

const SIMPLE_NOTE_DIALOGS: Record<string, { action: string; consequence: string; confirmLabel: string }> = {
  [LEAD_OPERATION_CODES.StartInformationGathering]: {
    action: 'Start information gathering',
    consequence: 'This lead moves to Information Gathering.',
    confirmLabel: 'Start information gathering',
  },
  [LEAD_OPERATION_CODES.StartPricing]: {
    action: 'Start pricing',
    consequence: 'This lead moves to Pricing.',
    confirmLabel: 'Start pricing',
  },
  [LEAD_OPERATION_CODES.StartNegotiation]: {
    action: 'Start negotiation',
    consequence: 'This lead moves to Negotiation.',
    confirmLabel: 'Start negotiation',
  },
};

/**
 * Lead Detail (spec FR-44, PRD 12.5, T-028): header (ref+party title, status chip, priority/
 * strategic flags, assignee avatar, age, contextual primary action, More actions, Edit lead),
 * read-only Request/Coverage/Party summary panels, the combined activity timeline with a prominent
 * next-follow-up banner, the closed-only outcome panel, and a Quotes card shell (T-029 populates it).
 * Every workflow action routes through `GET /leads/{id}`'s server-computed `availableOperations`
 * (spec FR-17/AC-016): the primary action and More-actions menu never invent an operation the server
 * did not grant.
 */
function LeadDetailPage() {
  const { leadId } = useParams<{ leadId: string }>();
  const id = Number(leadId);
  const navigate = useNavigate();
  // Deep-link from the Alerts center (T-037): `?highlightQuote=` highlights/expands the alerting
  // quote row in the Quotes card (spec FR-62's "row click opens Lead Detail with the alerting quote
  // highlighted"). Small, additive read of the param — the Quotes card ignores it when absent.
  const [searchParams] = useSearchParams();
  const highlightQuoteParam = searchParams.get('highlightQuote');
  const highlightQuoteId = highlightQuoteParam != null && !Number.isNaN(Number(highlightQuoteParam)) ? Number(highlightQuoteParam) : null;
  const { showSuccess } = useToast();
  const currencyCode = useTenantCurrency();
  const currencySymbol = useTenantCurrencySymbol();

  const canEdit = useAppSelector(selectHasPermission(PermissionCodes.LeadsUpdate));

  const [lead, setLead] = useState<LeadDetailDto | null>(null);
  const [party, setParty] = useState<PartyDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [requestChannelOptions, setRequestChannelOptions] = useState<ReferenceOption[] | null>(null);
  const [regionOptions, setRegionOptions] = useState<ReferenceOption[] | null>(null);
  const [partyTypeOptions, setPartyTypeOptions] = useState<ReferenceOption[] | null>(null);
  const [segmentOptions, setSegmentOptions] = useState<ReferenceOption[] | null>(null);
  const [industryOptions, setIndustryOptions] = useState<ReferenceOption[] | null>(null);
  const [lostReasons, setLostReasons] = useState<ReferenceItemDto[] | null>(null);
  const [businessAssignments, setBusinessAssignments] = useState<BusinessAssignmentsDto | null>(null);
  const [productLineOptions, setProductLineOptions] = useState<ReferenceItemDto[] | null>(null);
  const [coverTypeOptions, setCoverTypeOptions] = useState<ReferenceItemDto[] | null>(null);
  const [quoteStatusOptions, setQuoteStatusOptions] = useState<ReferenceItemDto[] | null>(null);
  const [quoteExpiryAlertDays, setQuoteExpiryAlertDays] = useState<number | null>(null);
  const [maxAttachmentMb, setMaxAttachmentMb] = useState<number | null>(null);

  const [timeline, setTimeline] = useState<TimelineEntryDto[]>([]);
  const [timelineTotal, setTimelineTotal] = useState(0);
  const [timelinePage, setTimelinePage] = useState(1);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineLoadingMore, setTimelineLoadingMore] = useState(false);

  const [quotes, setQuotes] = useState<QuoteListItemDto[]>([]);
  const quotesCardRef = useRef<QuotesCardHandle>(null);

  const [activeDialog, setActiveDialog] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  function loadTimeline(page: number, append: boolean): void {
    if (append) {
      setTimelineLoadingMore(true);
    } else {
      setTimelineLoading(true);
    }
    getLeadTimeline(id, page)
      .then((result) => {
        setTimeline((current) => (append ? [...current, ...result.items] : result.items));
        setTimelineTotal(result.totalCount);
        setTimelinePage(result.page);
      })
      .catch(() => {
        if (!append) {
          setTimeline([]);
        }
      })
      .finally(() => {
        if (append) {
          setTimelineLoadingMore(false);
        } else {
          setTimelineLoading(false);
        }
      });
  }

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getLead(id)
      .then((result) => {
        setLead(result);
        loadTimeline(1, false);
        getParty(result.partyId)
          .then(setParty)
          .catch(() => setParty(null));
      })
      .catch((err: unknown) => setError((err as NormalizedError).title ?? 'Unable to load this lead.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadTimeline closes over `id`, same identity as this callback.
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Refetches the lead + timeline in place after any quote workflow operation (T-029 brief: "after
   * any quote op: refetch lead (status may cascade), quotes list, and timeline; no full reload").
   * `QuotesCard` reloads its own quotes list itself; this only covers the lead-status-cascade and
   * timeline halves, without toggling the page-level `loading` flag (which would flash the whole
   * page back to its loading state instead of updating in place).
   */
  const reloadLeadInPlace = useCallback(() => {
    getLead(id)
      .then(setLead)
      .catch(() => {});
    loadTimeline(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadTimeline closes over `id`, same identity as this callback.
  }, [id]);

  useEffect(() => {
    listReferenceItems('request_channel').then((items) => setRequestChannelOptions(toReferenceOptions(items))).catch(() => setRequestChannelOptions(null));
    listReferenceItems('region').then((items) => setRegionOptions(toReferenceOptions(items))).catch(() => setRegionOptions(null));
    listReferenceItems('party_type').then((items) => setPartyTypeOptions(toReferenceOptions(items))).catch(() => setPartyTypeOptions(null));
    listReferenceItems('party_segment').then((items) => setSegmentOptions(toReferenceOptions(items))).catch(() => setSegmentOptions(null));
    listReferenceItems('industry').then((items) => setIndustryOptions(toReferenceOptions(items))).catch(() => setIndustryOptions(null));
    listReferenceItems('lost_reason').then(setLostReasons).catch(() => setLostReasons(null));
    listReferenceItems('product_line').then(setProductLineOptions).catch(() => setProductLineOptions(null));
    listReferenceItems('cover_type').then(setCoverTypeOptions).catch(() => setCoverTypeOptions(null));
    listReferenceItems('quote_status').then(setQuoteStatusOptions).catch(() => setQuoteStatusOptions(null));
    fetchBusinessAssignments()
      .then(setBusinessAssignments)
      .catch(() => setBusinessAssignments(null));
    fetchFullBusinessRules()
      .then((rules) => {
        setQuoteExpiryAlertDays(rules.quoteExpiryAlertDays);
        setMaxAttachmentMb(rules.maxAttachmentMb);
      })
      .catch(() => {
        setQuoteExpiryAlertDays(null);
        setMaxAttachmentMb(null);
      });
  }, []);

  function openDialogFor(op: string): void {
    setDialogError(null);
    if (op === LEAD_OPERATION_CODES.ApprovePricing || op === LEAD_OPERATION_CODES.RejectPricing) {
      setActiveDialog('approve-reject-pricing');
      return;
    }
    setActiveDialog(op);
  }

  function closeDialog(): void {
    setActiveDialog(null);
    setDialogError(null);
  }

  function handleOperationSuccess(updated: LeadDetailDto, message: string): void {
    setLead(updated);
    setDialogBusy(false);
    setDialogError(null);
    setActiveDialog(null);
    showSuccess(message);
    loadTimeline(1, false);
  }

  function handleOperationError(err: unknown): void {
    setDialogBusy(false);
    setDialogError((err as NormalizedError).title ?? 'Unable to complete this action.');
  }

  async function handleAssignConfirm(assignments: LeadAssignmentPayload[], comment: string | null): Promise<void> {
    if (!lead) {
      return;
    }
    const wasAlreadyOwned = lead.owner !== null;
    setDialogBusy(true);
    try {
      const updated = await assignLead(lead.id, assignments, comment);
      handleOperationSuccess(updated, `Lead ${updated.leadRef} ${wasAlreadyOwned ? 'reassigned' : 'assigned'}`);
    } catch (err) {
      handleOperationError(err);
    }
  }

  async function handleSendToUnderwritingConfirm(underwritingOwnerUserId: number, note: string | null): Promise<void> {
    if (!lead) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await sendLeadToUnderwriting(lead.id, underwritingOwnerUserId, note);
      handleOperationSuccess(updated, `Lead ${updated.leadRef} sent to underwriting`);
    } catch (err) {
      handleOperationError(err);
    }
  }

  async function handleSimpleNoteConfirm(op: string, note: string | null): Promise<void> {
    if (!lead) {
      return;
    }
    setDialogBusy(true);
    try {
      let updated: LeadDetailDto;
      if (op === LEAD_OPERATION_CODES.StartInformationGathering) {
        updated = await startLeadInformationGathering(lead.id, note);
      } else if (op === LEAD_OPERATION_CODES.StartPricing) {
        updated = await startLeadPricing(lead.id, note);
      } else {
        updated = await startLeadNegotiation(lead.id, note);
      }
      handleOperationSuccess(updated, `Lead ${updated.leadRef} updated`);
    } catch (err) {
      handleOperationError(err);
    }
  }

  async function handleRequestPricingApprovalConfirm(approverUserId: number, proposedPremium: number | null, note: string | null): Promise<void> {
    if (!lead) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await requestPricingApproval(lead.id, approverUserId, proposedPremium, note);
      handleOperationSuccess(updated, `Pricing approval requested for ${updated.leadRef}`);
    } catch (err) {
      handleOperationError(err);
    }
  }

  async function handleApprovePricing(note: string | null): Promise<void> {
    if (!lead) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await approvePricing(lead.id, note);
      handleOperationSuccess(updated, `Pricing approved for ${updated.leadRef}`);
    } catch (err) {
      handleOperationError(err);
    }
  }

  async function handleRejectPricing(reason: string): Promise<void> {
    if (!lead) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await rejectPricing(lead.id, reason);
      handleOperationSuccess(updated, `Pricing rejected for ${updated.leadRef}`);
    } catch (err) {
      handleOperationError(err);
    }
  }

  async function handleLogFollowUpConfirm(followUpDate: string | null, outcomeNote: string, nextFollowUpDate: string | null): Promise<void> {
    if (!lead) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await logFollowUp(lead.id, followUpDate, outcomeNote, nextFollowUpDate);
      handleOperationSuccess(updated, `Follow-up logged for ${updated.leadRef}`);
    } catch (err) {
      handleOperationError(err);
    }
  }

  async function handleMarkLostConfirm(
    lostReasonId: number,
    competitor: string | null,
    competitorPremium: number | null,
    lossComments: string | null,
  ): Promise<void> {
    if (!lead) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await markLeadLost(lead.id, lostReasonId, competitor, competitorPremium, lossComments);
      handleOperationSuccess(updated, `Lead ${updated.leadRef} marked Lost`);
    } catch (err) {
      handleOperationError(err);
    }
  }

  async function handleWithdrawConfirm(note: string): Promise<void> {
    if (!lead) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await withdrawLead(lead.id, note);
      handleOperationSuccess(updated, `Lead ${updated.leadRef} withdrawn`);
    } catch (err) {
      handleOperationError(err);
    }
  }

  async function handleReopenConfirm(reason: string): Promise<void> {
    if (!lead) {
      return;
    }
    setDialogBusy(true);
    try {
      const updated = await reopenLead(lead.id, reason);
      handleOperationSuccess(updated, `Lead ${updated.leadRef} reopened`);
    } catch (err) {
      handleOperationError(err);
    }
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  if (error || !lead) {
    return <ErrorBanner message={error ?? 'Lead not found.'} onRetry={load} />;
  }

  const reportingCategory = deriveLeadReportingCategory(lead.statusName);
  const isClosed = TERMINAL_CATEGORIES.has(reportingCategory);
  const leadPrimaryOp = resolvePrimaryOperation(lead);
  /**
   * Completes T-028's PrimaryActionResolver (spec: "draft-quote-exists -> Send", PRD 7.3/12.5, T-029):
   * when the lead has a draft quote, the header's primary action becomes "Send quote" (a quote-level
   * operation, not one of `LEAD_OPERATION_CODES`) rather than whatever lead-level op would otherwise
   * be primary — that lead-level op moves into the More-actions menu instead of disappearing.
   */
  const hasDraftQuote = quotes.some((quote) => quote.statusCanonicalKey === 'draft');
  const primaryOp = hasDraftQuote ? SEND_QUOTE_PSEUDO_OP : leadPrimaryOp;
  const moreOps = moreActionsOperations(lead, hasDraftQuote ? null : leadPrimaryOp);
  const canApprove = lead.availableOperations.includes(LEAD_OPERATION_CODES.ApprovePricing);
  const canReject = lead.availableOperations.includes(LEAD_OPERATION_CODES.RejectPricing);
  const simpleNoteConfig = activeDialog ? SIMPLE_NOTE_DIALOGS[activeDialog] : undefined;

  return (
    <div data-testid="lead-detail-page" className="qiq-page">
      <div data-testid="lead-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--qiq-space-4)', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-3)', flexWrap: 'wrap' }}>
          <h2 data-testid="lead-ref" style={{ fontSize: '20px' }}>{lead.leadRef}</h2>
          <span data-testid="lead-party-name" style={{ fontSize: '14px', fontWeight: 550, color: 'var(--qiq-text-secondary)' }}>
            {lead.partyName}
          </span>
          <StatusChip label={lead.statusName} category={reportingCategory} />
          {lead.priority === 'high' && (
            <span data-testid="priority-flag-chip" className="qiq-chip qiq-chip--warning" title="High priority">
              High priority
            </span>
          )}
          {party?.isStrategic && (
            <span data-testid="strategic-flag-icon" title="Strategic" aria-label="Strategic" style={{ color: 'var(--qiq-warning)' }}>
              ★
            </span>
          )}
          <span data-testid="assignee-avatars">
            {lead.owner ? (
              <span
                data-testid="assignee-avatar-owner"
                className="qiq-avatar"
                style={{ width: '28px', height: '28px', fontSize: '11px' }}
                title={`${lead.owner.firstName} ${lead.owner.lastName} (accountable owner)`}
              >
                {initials(lead.owner.firstName, lead.owner.lastName)}
              </span>
            ) : (
              <span data-testid="assignee-unassigned" className="qiq-chip qiq-chip--neutral">
                Unassigned
              </span>
            )}
          </span>
          <span data-testid="lead-age" className="qiq-chip qiq-chip--neutral" title={`${ageDaysFor(lead.dateReceived)} days since received`}>
            {ageDaysFor(lead.dateReceived)}d old
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--qiq-space-3)' }}>
          {canEdit && (
            <button type="button" onClick={() => navigate(`/leads/${id}/edit`)}>
              Edit lead
            </button>
          )}
          {primaryOp && (
            <button
              type="button"
              data-testid="primary-workflow-action"
              onClick={() => {
                if (primaryOp === SEND_QUOTE_PSEUDO_OP) {
                  quotesCardRef.current?.openSendDialogForDraft();
                  return;
                }
                openDialogFor(primaryOp);
              }}
            >
              {primaryOp === SEND_QUOTE_PSEUDO_OP ? 'Send quote' : labelForOperation(primaryOp, lead)}
            </button>
          )}
          <MoreActionsMenu operations={moreOps} lead={lead} onSelect={openDialogFor} />
        </div>
      </div>

      <SummaryPanel
        lead={lead}
        party={party}
        currencyCode={currencyCode}
        requestChannelOptions={requestChannelOptions}
        regionOptions={regionOptions}
        partyTypeOptions={partyTypeOptions}
        segmentOptions={segmentOptions}
        industryOptions={industryOptions}
      />

      <QuotesCard
        ref={quotesCardRef}
        lead={lead}
        currencySymbol={currencySymbol}
        quoteExpiryAlertDays={quoteExpiryAlertDays}
        maxAttachmentMb={maxAttachmentMb}
        roles={businessAssignments}
        lostReasons={lostReasons}
        quoteStatuses={quoteStatusOptions}
        productLineOptions={productLineOptions}
        coverTypeOptions={coverTypeOptions}
        isLeadClosed={isClosed}
        highlightQuoteId={highlightQuoteId}
        onQuotesLoaded={setQuotes}
        onQuoteMutated={reloadLeadInPlace}
      />

      <TimelinePanel
        entries={timeline}
        totalCount={timelineTotal}
        loading={timelineLoading}
        loadingMore={timelineLoadingMore}
        nextFollowUpDate={lead.nextFollowUpDate}
        isNextFollowUpOverdue={lead.isNextFollowUpOverdue}
        onLoadMore={() => loadTimeline(timelinePage + 1, true)}
        onLogFollowUp={() => openDialogFor(LEAD_OPERATION_CODES.LogFollowUp)}
      />

      {isClosed && (reportingCategory === 'won' || reportingCategory === 'lost' || reportingCategory === 'expired' || reportingCategory === 'withdrawn') && (
        <OutcomePanel lead={lead} outcomeCategory={reportingCategory} currencyCode={currencyCode} />
      )}

      <AssignDialog
        open={activeDialog === LEAD_OPERATION_CODES.Assign}
        lead={lead}
        roles={businessAssignments}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(assignments, comment) => void handleAssignConfirm(assignments, comment)}
        onCancel={closeDialog}
      />

      <SendToUnderwritingDialog
        open={activeDialog === LEAD_OPERATION_CODES.SendToUnderwriting}
        lead={lead}
        underwritingRole={businessAssignments?.underwritingRole ?? null}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(ownerId, note) => void handleSendToUnderwritingConfirm(ownerId, note)}
        onCancel={closeDialog}
      />

      <RequestPricingApprovalDialog
        open={activeDialog === LEAD_OPERATION_CODES.RequestPricingApproval}
        lead={lead}
        currencySymbol={currencySymbol}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(approverId, premium, note) => void handleRequestPricingApprovalConfirm(approverId, premium, note)}
        onCancel={closeDialog}
      />

      <ApproveRejectPricingDialog
        open={activeDialog === 'approve-reject-pricing'}
        lead={lead}
        currencySymbol={currencySymbol}
        canApprove={canApprove}
        canReject={canReject}
        busy={dialogBusy}
        error={dialogError}
        onApprove={(note) => void handleApprovePricing(note)}
        onReject={(reason) => void handleRejectPricing(reason)}
        onCancel={closeDialog}
      />

      <LogFollowUpDialog
        open={activeDialog === LEAD_OPERATION_CODES.LogFollowUp}
        lead={lead}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(followUpDate, outcomeNote, nextFollowUpDate) => void handleLogFollowUpConfirm(followUpDate, outcomeNote, nextFollowUpDate)}
        onCancel={closeDialog}
      />

      <MarkLostDialog
        open={activeDialog === LEAD_OPERATION_CODES.MarkLost}
        lead={lead}
        lostReasons={lostReasons}
        currencySymbol={currencySymbol}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(reasonId, competitor, competitorPremium, comments) => void handleMarkLostConfirm(reasonId, competitor, competitorPremium, comments)}
        onCancel={closeDialog}
      />

      <WithdrawDialog
        open={activeDialog === LEAD_OPERATION_CODES.Withdraw}
        lead={lead}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(note) => void handleWithdrawConfirm(note)}
        onCancel={closeDialog}
      />

      <ReopenDialog
        open={activeDialog === LEAD_OPERATION_CODES.Reopen}
        lead={lead}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={(reason) => void handleReopenConfirm(reason)}
        onCancel={closeDialog}
      />

      {simpleNoteConfig && activeDialog && (
        <SimpleNoteDialog
          open
          lead={lead}
          testId={`${activeDialog}-dialog`}
          action={simpleNoteConfig.action}
          consequence={simpleNoteConfig.consequence}
          confirmLabel={simpleNoteConfig.confirmLabel}
          busy={dialogBusy}
          error={dialogError}
          onConfirm={(note) => void handleSimpleNoteConfirm(activeDialog, note)}
          onCancel={closeDialog}
        />
      )}
    </div>
  );
}

export default LeadDetailPage;
