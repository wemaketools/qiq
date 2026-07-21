import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SummaryPanel from '../SummaryPanel';
import type { LeadDetailDto } from '../../leadsApi';
import type { PartyDto } from '../../../parties/partiesApi';

function makeLead(overrides: Partial<LeadDetailDto>): LeadDetailDto {
  return {
    id: 1,
    leadRef: 'L-2026-0001',
    externalRef: null,
    partyId: 42,
    partyName: 'Botswana Mining Co.',
    requestChannelId: 1,
    brokerId: null,
    brokerName: null,
    regionId: 2,
    productLineId: 1,
    productLineName: 'Motor',
    coverTypeId: 1,
    coverTypeName: 'Comprehensive',
    sumInsured: 1000000,
    estimatedPremium: 50000,
    policyTerm: 'annual',
    policyTermOther: null,
    priority: 'normal',
    isExistingClient: true,
    statusId: 1,
    statusName: 'Assigned',
    statusCanonicalKey: 'assigned',
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

const PARTY: PartyDto = {
  id: 42,
  name: 'Botswana Mining Co.',
  partyTypeId: 1,
  segmentId: 2,
  industryId: 3,
  regionId: 2,
  isStrategic: true,
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  lastActivityAt: null,
  openLeadsCount: 1,
  totalLeadsCount: 2,
};

describe('SummaryPanel', () => {
  it('render_WhenLoaded_ShouldShowRequestCoverageAndPartyGroups', () => {
    // Arrange & Act
    render(
      <MemoryRouter>
        <SummaryPanel
          lead={makeLead({})}
          party={PARTY}
          currencyCode="BWP"
          requestChannelOptions={[{ id: 1, name: 'Direct email' }]}
          regionOptions={[{ id: 2, name: 'Gaborone' }]}
          partyTypeOptions={[{ id: 1, name: 'Corporate' }]}
          segmentOptions={[{ id: 2, name: 'Enterprise' }]}
          industryOptions={[{ id: 3, name: 'Mining' }]}
        />
      </MemoryRouter>,
    );

    // Assert
    expect(screen.getByTestId('summary-request-group')).toHaveTextContent('Direct email');
    expect(screen.getByTestId('summary-request-group')).toHaveTextContent('Gaborone');
    expect(screen.getByTestId('summary-coverage-group')).toHaveTextContent('Motor');
    expect(screen.getByTestId('summary-party-card')).toHaveTextContent('Mining');
    expect(screen.getByTestId('party-strategic-flag')).toBeInTheDocument();
  });

  it('click_WhenPartyCardLinkClicked_ShouldNavigateToPartyDetail', () => {
    // Arrange
    render(
      <MemoryRouter>
        <SummaryPanel
          lead={makeLead({})}
          party={PARTY}
          currencyCode="BWP"
          requestChannelOptions={null}
          regionOptions={null}
          partyTypeOptions={null}
          segmentOptions={null}
          industryOptions={null}
        />
      </MemoryRouter>,
    );

    // Act & Assert (no crash; link points at the party route)
    const link = screen.getByTestId('party-card-link');
    expect(link).toHaveAttribute('href', '/parties/42');
    fireEvent.click(link);
  });
});
