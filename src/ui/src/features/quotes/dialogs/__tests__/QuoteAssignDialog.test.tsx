import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QuoteAssignDialog from '../QuoteAssignDialog';
import type { BusinessAssignmentsDto } from '../../../settings/settingsApi';

vi.mock('../../../leads/leadsApi', async () => {
  const actual = await vi.importActual<typeof import('../../../leads/leadsApi')>('../../../leads/leadsApi');
  return { ...actual, getEligibleAssignees: vi.fn(() => Promise.resolve([])) };
});

const ROLES: BusinessAssignmentsDto = {
  rmRole: null,
  underwritingRole: { assignmentId: 10, roleId: 1, roleName: 'Underwriter' },
};

describe('QuoteAssignDialog', () => {
  it('render_WhenNoRolesConfigured_ShouldShowConfigurationWarning', () => {
    // Arrange & Act
    render(<QuoteAssignDialog open quoteRef="Q-2026-0001" partyName="Acme" roles={{ rmRole: null, underwritingRole: null }} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    // Assert
    expect(screen.getByTestId('quote-assign-no-roles-configured')).toBeInTheDocument();
  });

  it('click_WhenConfirmedWithoutAnySelection_ShouldShowInlineErrorAndNotConfirm', () => {
    // Arrange
    const onConfirm = vi.fn();
    render(<QuoteAssignDialog open quoteRef="Q-2026-0001" partyName="Acme" roles={ROLES} onConfirm={onConfirm} onCancel={vi.fn()} />);

    // Act
    fireEvent.click(screen.getByTestId('dialog-primary-button'));

    // Assert
    expect(screen.getByTestId('field-error-assignments')).toHaveTextContent('At least one role assignment is required.');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('render_WhenOpen_ShouldShowAssignTitle', () => {
    // Arrange & Act
    render(<QuoteAssignDialog open quoteRef="Q-2026-0001" partyName="Acme" roles={ROLES} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    // Assert
    expect(screen.getByTestId('workflow-dialog-title')).toHaveTextContent('Assign — Q-2026-0001 · Acme');
    expect(screen.getByTestId('quote-role-select-underwriter')).toBeInTheDocument();
  });
});
