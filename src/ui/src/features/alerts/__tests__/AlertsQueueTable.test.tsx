import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import AlertsQueueTable from '../AlertsQueueTable';
import type { AlertListItemDto } from '../alertsApi';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

function makeAlert(overrides: Partial<AlertListItemDto> = {}): AlertListItemDto {
  return {
    id: 1,
    type: 'unassigned_lead',
    severity: 'warning',
    createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
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

describe('AlertsQueueTable', () => {
  beforeEach(() => {
    navigate.mockClear();
  });

  it('render_ShouldShowRefClientProductBrokerPremiumStageOwner', () => {
    // Arrange & Act
    render(<AlertsQueueTable alerts={[makeAlert()]} currencyCode="BWP" agingAmberDays={10} agingRedDays={20} onAction={vi.fn()} />);

    // Assert
    expect(screen.getByTestId('alert-ref-cell')).toHaveTextContent('Q-2025-1503');
    expect(screen.getByText('Okavango Holdings Group')).toBeInTheDocument();
    expect(screen.getByTestId('alert-product-line')).toHaveTextContent('Machinery Breakdown');
    expect(screen.getByText('Northern Agri Brokers')).toBeInTheDocument();
    expect(screen.getByTestId('alert-premium-cell')).toHaveTextContent('1,269,800');
    expect(screen.getByTestId('status-chip')).toHaveTextContent('New Quote');
    expect(screen.getByText('Lesedi Phiri')).toBeInTheDocument();
  });

  it('render_WhenNoBroker_ShouldShowDirect', () => {
    render(
      <AlertsQueueTable
        alerts={[makeAlert({ brokerName: null })]}
        currencyCode="BWP"
        agingAmberDays={10}
        agingRedDays={20}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('Direct')).toBeInTheDocument();
  });

  it('render_WhenAgePastRedThreshold_ShouldToneRowAgeRed', () => {
    render(
      <AlertsQueueTable
        alerts={[makeAlert({ createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() })]}
        currencyCode="BWP"
        agingAmberDays={10}
        agingRedDays={20}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId('alert-age-cell')).toHaveAttribute('data-tone', 'red');
  });

  it('rowClick_ShouldOpenLeadDetailWithHighlightQuoteParam', () => {
    render(<AlertsQueueTable alerts={[makeAlert()]} currencyCode="BWP" agingAmberDays={10} agingRedDays={20} onAction={vi.fn()} />);

    fireEvent.click(screen.getByTestId('alert-row'));

    expect(navigate).toHaveBeenCalledWith('/leads/40?highlightQuote=88');
  });

  it('rowClick_WhenAlertHasNoQuote_ShouldOpenLeadDetailWithoutParam', () => {
    render(
      <AlertsQueueTable
        alerts={[makeAlert({ quoteId: null, quoteRef: null })]}
        currencyCode="BWP"
        agingAmberDays={10}
        agingRedDays={20}
        onAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('alert-row'));
    expect(navigate).toHaveBeenCalledWith('/leads/40');
  });

  it('actionClick_ShouldInvokeOnActionWithoutNavigating', () => {
    const onAction = vi.fn();
    render(<AlertsQueueTable alerts={[makeAlert()]} currencyCode="BWP" agingAmberDays={10} agingRedDays={20} onAction={onAction} />);

    fireEvent.click(screen.getByTestId('alert-action-link'));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('render_ShouldMapAlertTypeToContextualActionLabel', () => {
    render(
      <AlertsQueueTable
        alerts={[
          makeAlert({ id: 1, type: 'unassigned_lead' }),
          makeAlert({ id: 2, type: 'overdue_follow_up' }),
          makeAlert({ id: 3, type: 'executive_escalation' }),
          makeAlert({ id: 4, type: 'sla_breach' }),
        ]}
        currencyCode="BWP"
        agingAmberDays={10}
        agingRedDays={20}
        onAction={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId('alert-row');
    expect(within(rows[0]!).getByTestId('alert-action-link')).toHaveTextContent('Assign & acknowledge');
    expect(within(rows[1]!).getByTestId('alert-action-link')).toHaveTextContent('Follow up');
    expect(within(rows[2]!).getByTestId('alert-action-link')).toHaveTextContent('Executive review');
    // sla_breach has no contextual action link
    expect(within(rows[3]!).queryByTestId('alert-action-link')).toBeNull();
  });
});
