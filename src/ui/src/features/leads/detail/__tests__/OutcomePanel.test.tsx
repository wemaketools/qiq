import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import OutcomePanel from '../OutcomePanel';
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
    statusName: 'Closed Won',
    statusCanonicalKey: 'closed_won',
    dateReceived: '2026-01-01',
    source: 'api',
    owner: { userId: 9, firstName: 'Sam', lastName: 'RM' },
    notes: [],
    availableOperations: [],
    lastFollowUpDate: null,
    nextFollowUpDate: null,
    isNextFollowUpOverdue: false,
    ...overrides,
  };
}

describe('OutcomePanel', () => {
  it('render_WhenWon_ShouldShowBoundPremiumRowAndNotLostFields', () => {
    // Arrange & Act
    render(<OutcomePanel lead={makeLead({ boundPremium: 60000 })} outcomeCategory="won" currencyCode="BWP" />);

    // Assert
    expect(screen.getByTestId('outcome-status')).toHaveTextContent('Closed Won');
    expect(screen.getByTestId('outcome-bound-premium')).toHaveTextContent('60,000');
    expect(screen.queryByTestId('outcome-lost-reason')).not.toBeInTheDocument();
  });

  it('render_WhenLost_ShouldShowReasonCompetitorAndComments', () => {
    // Arrange & Act
    render(
      <OutcomePanel
        lead={makeLead({
          statusName: 'Closed Lost',
          statusCanonicalKey: 'closed_lost',
          lostReasonName: 'Competitor won',
          competitor: 'Rival Co.',
          lossComments: 'Priced too high',
        })}
        outcomeCategory="lost"
        currencyCode="BWP"
      />,
    );

    // Assert
    expect(screen.getByTestId('outcome-lost-reason')).toHaveTextContent('Competitor won');
    expect(screen.getByTestId('outcome-competitor')).toHaveTextContent('Rival Co.');
    expect(screen.getByTestId('outcome-loss-comments')).toHaveTextContent('Priced too high');
    expect(screen.queryByTestId('outcome-bound-premium')).not.toBeInTheDocument();
  });

  it('render_WhenOutcomeFieldsNotYetProjectedByBackend_ShouldDegradeToPlaceholders', () => {
    // Arrange & Act
    render(<OutcomePanel lead={makeLead({})} outcomeCategory="won" currencyCode="BWP" />);

    // Assert
    expect(screen.getByTestId('outcome-decision-date')).toHaveTextContent('—');
    expect(screen.getByTestId('outcome-closed-by')).toHaveTextContent('—');
  });
});
