import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContactsEditor, { type ContactRow } from '../ContactsEditor';

/**
 * Broker contacts editor primary-radio behavior (spec FR-24, AC-023, T-016): adding a contact and
 * marking a different one primary keeps exactly one row checked in the UX (the real invariant is
 * server-enforced; this proves the client-side bookkeeping `BrokerFormDrawer` relies on when
 * translating the UI state into the real add/update/set-primary calls).
 */
describe('ContactsEditor', () => {
  const baseContacts: ContactRow[] = [
    { key: 'existing-1', id: 1, name: 'First Contact', email: '', phone: '', isPrimary: true },
    { key: 'existing-2', id: 2, name: 'Second Contact', email: '', phone: '', isPrimary: false },
  ];

  it('setPrimary_WhenSecondContactMarkedPrimary_ShouldDemoteFirstContact', () => {
    // Arrange
    const onChange = vi.fn();
    render(<ContactsEditor contacts={baseContacts} onChange={onChange} />);

    // Act
    fireEvent.click(screen.getByLabelText('Primary contact 2'));

    // Assert
    expect(onChange).toHaveBeenCalledWith([
      { ...baseContacts[0], isPrimary: false },
      { ...baseContacts[1], isPrimary: true },
    ]);
  });

  it('addContact_WhenNoContactsExist_ShouldAutoMarkTheFirstAddedContactPrimary', () => {
    // Arrange
    const onChange = vi.fn();
    render(<ContactsEditor contacts={[]} onChange={onChange} />);

    // Act
    fireEvent.click(screen.getByRole('button', { name: '+ Add contact' }));

    // Assert
    const [added] = onChange.mock.calls[0] as [ContactRow[]];
    expect(added).toHaveLength(1);
    expect(added[0]?.isPrimary).toBe(true);
  });

  it('removeContact_WhenRemovingThePrimaryContact_ShouldPromoteTheRemainingContact', () => {
    // Arrange
    const onChange = vi.fn();
    render(<ContactsEditor contacts={baseContacts} onChange={onChange} />);

    // Act
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove contact' })[0]!);

    // Assert
    expect(onChange).toHaveBeenCalledWith([{ ...baseContacts[1], isPrimary: true }]);
  });
});
