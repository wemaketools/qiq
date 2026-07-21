import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QuoteDetailPanel from '../QuoteDetailPanel';
import type { QuoteDetailDto } from '../quotesApi';
import type { ReferenceItemDto } from '../../settings/settingsApi';

function makeQuote(overrides: Partial<QuoteDetailDto> = {}): QuoteDetailDto {
  return {
    id: 5,
    quoteRef: 'Q-2026-0005',
    leadId: 1,
    statusId: 3,
    statusName: 'Revised',
    statusCanonicalKey: 'revised',
    isCurrent: true,
    productLineId: 1,
    productLineName: 'Motor',
    coverTypeId: 10,
    coverTypeName: 'Comprehensive',
    preparedDate: '2026-06-01',
    sentDate: '2026-06-05',
    validUntil: '2026-08-05',
    decisionDate: null,
    boundPremium: null,
    lostReasonId: null,
    competitor: null,
    competitorPremium: null,
    lossComments: null,
    withdrawalNote: null,
    notes: 'Standard terms',
    versions: [
      { id: 1, versionNo: 1, quotedPremium: 500000, termsNotes: null, revisionNote: null, isCurrent: false, createdAt: '2026-06-01T00:00:00Z' },
      { id: 2, versionNo: 2, quotedPremium: 450000, termsNotes: null, revisionNote: 'Lower premium requested', isCurrent: true, createdAt: '2026-06-05T00:00:00Z' },
    ],
    history: [{ operation: 'send', previousStatusId: 1, newStatusId: 2, actedBy: 9, actedAt: '2026-06-05T00:00:00Z' }],
    availableOperations: ['mark-won', 'mark-lost', 'withdraw', 'assign'],
    ...overrides,
  };
}

const QUOTE_STATUSES: ReferenceItemDto[] = [
  { id: 1, listType: 'quote_status', name: 'Draft', displayOrder: 1, isActive: true, isBrokerChannel: null, productLineId: null, reportingCategory: null, canonicalKey: 'draft', isTerminal: false },
  { id: 2, listType: 'quote_status', name: 'Sent', displayOrder: 2, isActive: true, isBrokerChannel: null, productLineId: null, reportingCategory: null, canonicalKey: 'sent', isTerminal: false },
];

describe('QuoteDetailPanel', () => {
  it('render_WhenViewed_ShouldShowFieldGridVersionHistoryAndStatusHistory', () => {
    // Arrange & Act
    render(
      <QuoteDetailPanel
        quote={makeQuote()}
        currencySymbol="BWP"
        quoteStatuses={QUOTE_STATUSES}
        attachments={[]}
        maxAttachmentMb={10}
        canCorrectClosed={false}
        onAttachmentUploaded={vi.fn()}
        onAttachmentRemoved={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    // Assert
    expect(screen.getByTestId('quote-field-grid')).toBeInTheDocument();
    expect(screen.getAllByTestId('version-history-entry')).toHaveLength(2);
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getAllByTestId('version-current-badge')).toHaveLength(1);
    expect(screen.getAllByTestId('quote-status-history-entry')).toHaveLength(1);
    expect(screen.getByTestId('attachments-section')).toBeInTheDocument();
  });

  it('render_WhenAvailableOperationsGiven_ShouldOnlyRenderThoseButtons', () => {
    // Arrange & Act
    render(
      <QuoteDetailPanel
        quote={makeQuote({ availableOperations: ['mark-won', 'mark-lost', 'withdraw', 'assign'] })}
        currencySymbol="BWP"
        quoteStatuses={QUOTE_STATUSES}
        attachments={[]}
        maxAttachmentMb={10}
        canCorrectClosed={false}
        onAttachmentUploaded={vi.fn()}
        onAttachmentRemoved={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    // Assert (V-046: for a Revised quote, Send is NOT among the legal buttons)
    expect(screen.getByTestId('quote-action-mark-won')).toBeInTheDocument();
    expect(screen.getByTestId('quote-action-mark-lost')).toBeInTheDocument();
    expect(screen.getByTestId('quote-action-withdraw')).toBeInTheDocument();
    expect(screen.getByTestId('quote-action-assign')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-action-send')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-action-revise')).not.toBeInTheDocument();
  });

  it('click_WhenActionButtonClicked_ShouldCallOnActionWithOperationCode', () => {
    // Arrange
    const onAction = vi.fn();
    render(
      <QuoteDetailPanel
        quote={makeQuote()}
        currencySymbol="BWP"
        quoteStatuses={QUOTE_STATUSES}
        attachments={[]}
        maxAttachmentMb={10}
        canCorrectClosed={false}
        onAttachmentUploaded={vi.fn()}
        onAttachmentRemoved={vi.fn()}
        onAction={onAction}
      />,
    );

    // Act
    fireEvent.click(screen.getByTestId('quote-action-mark-won'));

    // Assert
    expect(onAction).toHaveBeenCalledWith('mark-won');
  });
});
