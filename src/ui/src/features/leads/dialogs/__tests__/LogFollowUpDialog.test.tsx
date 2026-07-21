import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LogFollowUpDialog from '../LogFollowUpDialog';
import type { LeadDetailDto } from '../../leadsApi';

function makeLead(overrides: Partial<LeadDetailDto>): LeadDetailDto {
  return {
    id: 1,
    leadRef: 'L-2026-0001',
    externalRef: null,
    partyId: 1,
    partyName: 'Botswana Mining Co.',
    requestChannelId: 1,
    brokerId: null,
    brokerName: null,
    regionId: 1,
    productLineId: 1,
    productLineName: 'Motor',
    coverTypeId: 1,
    coverTypeName: 'Comprehensive',
    sumInsured: null,
    estimatedPremium: null,
    policyTerm: 'annual',
    policyTermOther: null,
    priority: 'normal',
    isExistingClient: false,
    statusId: 1,
    statusName: 'Assigned',
    statusCanonicalKey: 'assigned',
    dateReceived: '2026-01-01',
    source: 'api',
    owner: { userId: 9, firstName: 'Sam', lastName: 'RM' },
    notes: [],
    availableOperations: ['log-follow-up'],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

function tomorrowIso(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

describe('LogFollowUpDialog', () => {
  it('click_WhenConfirmedWithoutOutcomeNote_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<LogFollowUpDialog open lead={makeLead({})} onConfirm={onConfirm} onCancel={vi.fn()} />);

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('field-error-outcome-note')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenLeadPastQuoteSentAndNextDateOmitted_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<LogFollowUpDialog open lead={makeLead({ statusName: 'Quote Sent', statusCanonicalKey: 'quote_sent' })} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('follow-up-outcome-note-textarea'), { target: { value: 'Called client' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('field-error-next-follow-up')).toHaveTextContent('required while this lead is open past Quote Sent');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenLeadPastQuoteSentAndNextDateNotInFuture_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<LogFollowUpDialog open lead={makeLead({ statusName: 'Quote Sent', statusCanonicalKey: 'quote_sent' })} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('follow-up-outcome-note-textarea'), { target: { value: 'Called client' } });
    fireEvent.change(screen.getByLabelText('Next follow-up date *'), { target: { value: new Date().toISOString().slice(0, 10) } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('field-error-next-follow-up')).toHaveTextContent('must be in the future');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('click_WhenLeadPastQuoteSentAndValidFutureNextDate_ShouldCallOnConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<LogFollowUpDialog open lead={makeLead({ statusName: 'Quote Sent', statusCanonicalKey: 'quote_sent' })} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('follow-up-outcome-note-textarea'), { target: { value: 'Called client' } });
    fireEvent.change(screen.getByLabelText('Next follow-up date *'), { target: { value: tomorrowIso() } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(expect.any(String), 'Called client', tomorrowIso());
  });

  it('click_WhenLeadNotPastQuoteSentAndNextDateOmitted_ShouldConfirmWithNullNextDate', () => {
    // Arrange (Assigned status is not reporting-category "quoted" — next date is optional)
    const onConfirm = vi.fn();
    render(<LogFollowUpDialog open lead={makeLead({})} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('follow-up-outcome-note-textarea'), { target: { value: 'Left voicemail' } });

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(onConfirm).toHaveBeenCalledWith(expect.any(String), 'Left voicemail', null);
  });
});
