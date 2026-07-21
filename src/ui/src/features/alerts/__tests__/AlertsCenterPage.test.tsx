import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { sessionReducer } from '../../../app/slices/sessionSlice';
import { alertsBadgeReducer } from '../../../app/slices/alertsBadgeSlice';
import AlertsCenterPage from '../AlertsCenterPage';
import { getAlertSummary, listAlerts, getAlertBadge, resetAlertBadge, type AlertListItemDto } from '../alertsApi';
import { getLead, getEligibleLeadOwners, logFollowUp } from '../../leads/leadsApi';
import { fetchBusinessAssignments, listReferenceItems } from '../../settings/settingsApi';

vi.mock('../alertsApi', async () => {
  const actual = await vi.importActual<typeof import('../alertsApi')>('../alertsApi');
  return {
    ...actual,
    getAlertSummary: vi.fn(),
    listAlerts: vi.fn(),
    getAlertBadge: vi.fn(() => Promise.resolve({ count: 0 })),
    resetAlertBadge: vi.fn(() => Promise.resolve(undefined)),
  };
});

vi.mock('../../leads/leadsApi', async () => {
  const actual = await vi.importActual<typeof import('../../leads/leadsApi')>('../../leads/leadsApi');
  return {
    ...actual,
    getLead: vi.fn(),
    getEligibleLeadOwners: vi.fn(() => Promise.resolve([])),
    assignLead: vi.fn(),
    logFollowUp: vi.fn(),
  };
});

vi.mock('../../settings/settingsApi', async () => {
  const actual = await vi.importActual<typeof import('../../settings/settingsApi')>('../../settings/settingsApi');
  return {
    ...actual,
    listReferenceItems: vi.fn(() => Promise.resolve([])),
    fetchFullBusinessRules: vi.fn(() => Promise.reject(new Error('no rules'))),
    fetchBusinessAssignments: vi.fn(() => Promise.resolve({ leadRoles: [], quoteRoles: [] })),
  };
});

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

const SUMMARY = {
  categories: [
    { category: 'escalated', name: 'Escalated', definition: 'High-value & stalled', tab: 'escalated', count: 4 },
    { category: 'stalled', name: 'Stalled', definition: 'No activity 7+ days', tab: null, count: 9 },
    { category: 'overdue', name: 'Overdue', definition: 'Follow-up overdue', tab: 'overdue', count: 1 },
    { category: 'expiring', name: 'Expiring', definition: 'Within threshold / expired', tab: 'expiring', count: 1 },
    { category: 'sla', name: 'SLA Breaches', definition: 'Underwriting/assignment beyond SLA', tab: 'sla', count: 5 },
  ],
  rollup: { premiumAtRisk: 6_300_000, quoteCount: 12 },
};

function makeAlert(overrides: Partial<AlertListItemDto> = {}): AlertListItemDto {
  return {
    id: 1,
    type: 'unassigned_lead',
    severity: 'warning',
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    leadId: 40,
    leadRef: 'L-2025-0040',
    quoteId: 88,
    quoteRef: 'Q-2025-1503',
    clientName: 'Okavango Holdings Group',
    productLineName: 'Machinery Breakdown',
    brokerName: 'Northern Agri Brokers',
    premiumAtRisk: 1_269_800,
    stage: 'New Quote',
    priority: 'high',
    ownerUserId: 5,
    ownerName: 'Lesedi Phiri',
    ...overrides,
  };
}

const LIST = {
  items: [makeAlert()],
  totalCount: 1,
  page: 1,
  pageSize: 25,
  tabCounts: { all: 13, escalated: 4, overdue: 1, expiring: 1, sla: 5 },
};

function renderPage(initialUrl = '/alerts') {
  const store = configureStore({ reducer: { session: sessionReducer, alertsBadge: alertsBadgeReducer } });
  const router = createMemoryRouter(
    [
      { path: '/alerts', element: <AlertsCenterPage /> },
      { path: '/leads/:id', element: <div data-testid="lead-detail-stub">lead detail</div> },
    ],
    { initialEntries: [initialUrl] },
  );
  return { store, ...render(<Provider store={store}><RouterProvider router={router} /></Provider>) };
}

describe('AlertsCenterPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAlertSummary).mockResolvedValue(SUMMARY);
    vi.mocked(listAlerts).mockResolvedValue(LIST);
    vi.mocked(getAlertBadge).mockResolvedValue({ count: 0 });
    vi.mocked(resetAlertBadge).mockResolvedValue(undefined);
    vi.mocked(getEligibleLeadOwners).mockResolvedValue([]);
    vi.mocked(listReferenceItems).mockResolvedValue([]);
  });

  it('mount_ShouldResetPerUserBadgeServerSide', async () => {
    // Act
    renderPage();

    // Assert
    await waitFor(() => expect(resetAlertBadge).toHaveBeenCalledTimes(1));
  });

  it('render_ShouldShowCategoryCardsAndPremiumAtRiskRollup', async () => {
    // Act
    renderPage();

    // Assert
    await waitFor(() => expect(screen.getAllByTestId('alert-category-card')).toHaveLength(5));
    expect(screen.getByTestId('premium-at-risk-rollup')).toHaveTextContent('Premium at risk: BWP 6.3M · 12 quotes');
    expect(screen.getByTestId('alerts-tab-count-all')).toHaveTextContent('13');
    expect(screen.getByTestId('alerts-tab-count-sla')).toHaveTextContent('5');
  });

  it('deepLink_WhenCategoryParamPresent_ShouldActivateMatchingTab', async () => {
    // Act
    renderPage('/alerts?category=expiring');

    // Assert
    await waitFor(() => expect(screen.getByTestId('alerts-tab-expiring')).toHaveAttribute('data-active', 'true'));
    expect(listAlerts).toHaveBeenCalledWith(expect.objectContaining({ tab: 'expiring' }));
  });

  it('categoryCardClick_ShouldActivateThatTabAndRefetch', async () => {
    // Arrange
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('alert-category-card')).toHaveLength(5));

    // Act
    fireEvent.click(screen.getByText('SLA Breaches'));

    // Assert
    await waitFor(() => expect(screen.getByTestId('alerts-tab-sla')).toHaveAttribute('data-active', 'true'));
    expect(listAlerts).toHaveBeenLastCalledWith(expect.objectContaining({ tab: 'sla' }));
  });

  it('assignAction_ShouldFetchLeadAndOpenAssignDialog', async () => {
    // Arrange
    vi.mocked(getLead).mockResolvedValue({
      id: 40,
      leadRef: 'L-2025-0040',
      partyName: 'Okavango Holdings Group',
      owner: null,
      statusCanonicalKey: 'new',
      availableOperations: ['assign'],
    } as never);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('alert-action-link')).toBeInTheDocument());

    // Act
    fireEvent.click(screen.getByTestId('alert-action-link'));

    // Assert
    await waitFor(() => expect(screen.getByTestId('assign-dialog')).toBeInTheDocument());
    expect(getLead).toHaveBeenCalledWith(40);
    expect(fetchBusinessAssignments).toHaveBeenCalled();
  });

  it('load_WhenListEmpty_ShouldShowEmptyState', async () => {
    // Arrange
    vi.mocked(listAlerts).mockResolvedValue({ ...LIST, items: [], totalCount: 0 });

    // Act
    renderPage();

    // Assert
    await waitFor(() => expect(screen.getByText('No alerts match the current filters.')).toBeInTheDocument());
  });

  it('executiveReviewAction_WhenLeadPastQuoteSent_ShouldRequireFutureNextFollowUpDateAndNotDeadEnd', async () => {
    // Arrange — a high-value stalled alert on a Quoted-category (open past Quote Sent) lead: the
    // backend LogFollowUpCommandHandler would reject a null next-follow-up date, so the dialog must
    // collect one (F-037-06 regression guard).
    vi.mocked(listAlerts).mockResolvedValue({
      ...LIST,
      items: [makeAlert({ type: 'high_value_stalled', quoteRef: 'Q-2025-1503' })],
    });
    vi.mocked(getLead).mockResolvedValue({
      id: 40,
      leadRef: 'L-2025-0040',
      partyName: 'Okavango Holdings Group',
      statusName: 'Quote Sent',
      statusCanonicalKey: 'quote_sent',
      owner: null,
      availableOperations: ['log-follow-up'],
    } as never);
    vi.mocked(logFollowUp).mockResolvedValue({ leadRef: 'L-2025-0040' } as never);
    const futureDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('alert-action-link')).toBeInTheDocument());

    // Act — open the executive-review dialog.
    fireEvent.click(screen.getByTestId('alert-action-link'));
    await waitFor(() => expect(screen.getByTestId('executive-review-dialog')).toBeInTheDocument());

    // Assert — the next-follow-up date field is present and required.
    expect(screen.getByTestId('executive-review-next-follow-up-date')).toBeInTheDocument();
    expect(getLead).toHaveBeenCalledWith(40);

    // Act — submit with a comment but no date: client validation must block the backend call.
    fireEvent.change(screen.getByTestId('executive-review-comment-textarea'), {
      target: { value: 'Escalated to underwriting head.' },
    });
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert — blocked, error shown, no dead-end 4xx round-trip.
    await waitFor(() => expect(screen.getByTestId('field-error-exec-next-follow-up')).toBeInTheDocument());
    expect(logFollowUp).not.toHaveBeenCalled();

    // Act — provide a future date and resubmit.
    fireEvent.change(screen.getByTestId('executive-review-next-follow-up-date'), {
      target: { value: futureDate },
    });
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert — the review is submitted through logFollowUp WITH the future date.
    await waitFor(() => expect(logFollowUp).toHaveBeenCalledTimes(1));
    expect(logFollowUp).toHaveBeenCalledWith(40, expect.any(String), 'Escalated to underwriting head.', futureDate);
  });

  it('executiveReviewAction_WhenLeadNotPastQuoteSent_ShouldSubmitCommentOnlyWithNullDate', async () => {
    // Arrange — an executive escalation on a pre-Quote-Sent lead: no next-follow-up date required.
    vi.mocked(listAlerts).mockResolvedValue({
      ...LIST,
      items: [makeAlert({ type: 'executive_escalation', quoteRef: 'Q-2025-1503' })],
    });
    vi.mocked(getLead).mockResolvedValue({
      id: 40,
      leadRef: 'L-2025-0040',
      partyName: 'Okavango Holdings Group',
      statusName: 'New',
      statusCanonicalKey: 'new',
      owner: null,
      availableOperations: ['log-follow-up'],
    } as never);
    vi.mocked(logFollowUp).mockResolvedValue({ leadRef: 'L-2025-0040' } as never);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('alert-action-link')).toBeInTheDocument());

    // Act — open the dialog.
    fireEvent.click(screen.getByTestId('alert-action-link'));
    await waitFor(() => expect(screen.getByTestId('executive-review-dialog')).toBeInTheDocument());

    // Assert — no next-follow-up date field for a pre-Quote-Sent lead.
    expect(screen.queryByTestId('executive-review-next-follow-up-date')).not.toBeInTheDocument();

    // Act — comment only, submit.
    fireEvent.change(screen.getByTestId('executive-review-comment-textarea'), {
      target: { value: 'Reviewed and acknowledged.' },
    });
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert — submitted with a null next-follow-up date (current behavior preserved).
    await waitFor(() => expect(logFollowUp).toHaveBeenCalledTimes(1));
    expect(logFollowUp).toHaveBeenCalledWith(40, expect.any(String), 'Reviewed and acknowledged.', null);
  });

  it('rowClick_ShouldNavigateToLeadDetailWithHighlightedQuote', async () => {
    // Arrange
    renderPage();
    await waitFor(() => expect(screen.getByTestId('alert-row')).toBeInTheDocument());

    // Act
    fireEvent.click(screen.getByTestId('alert-row'));

    // Assert
    await waitFor(() => expect(screen.getByTestId('lead-detail-stub')).toBeInTheDocument());
  });
});
