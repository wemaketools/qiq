import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CategoryCards from '../CategoryCards';
import type { AlertCategoryCardDto } from '../alertsApi';

const CATEGORIES: AlertCategoryCardDto[] = [
  { category: 'escalated', name: 'Escalated', definition: 'High-value & stalled', tab: 'escalated', count: 4 },
  { category: 'stalled', name: 'Stalled', definition: 'No activity 7+ days', tab: null, count: 9 },
  { category: 'overdue', name: 'Overdue', definition: 'Follow-up overdue', tab: 'overdue', count: 1 },
  { category: 'expiring', name: 'Expiring', definition: 'Within threshold / expired', tab: 'expiring', count: 1 },
  { category: 'sla', name: 'SLA Breaches', definition: 'Underwriting/assignment beyond SLA', tab: 'sla', count: 5 },
];

describe('CategoryCards', () => {
  it('render_ShouldShowEachCategoryNameDefinitionAndCount', () => {
    // Arrange & Act
    render(<CategoryCards categories={CATEGORIES} activeTab="all" onSelectTab={vi.fn()} />);

    // Assert
    expect(screen.getAllByTestId('alert-category-card')).toHaveLength(5);
    expect(screen.getByText('Escalated')).toBeInTheDocument();
    expect(screen.getByText('High-value & stalled')).toBeInTheDocument();
    expect(screen.getByText('No activity 7+ days')).toBeInTheDocument();
    const counts = screen.getAllByTestId('alert-category-count').map((el) => el.textContent);
    expect(counts).toEqual(['4', '9', '1', '1', '5']);
  });

  it('click_WhenCardHasTab_ShouldActivateThatTab', () => {
    // Arrange
    const onSelectTab = vi.fn();
    render(<CategoryCards categories={CATEGORIES} activeTab="all" onSelectTab={onSelectTab} />);

    // Act
    fireEvent.click(screen.getByText('Expiring'));

    // Assert
    expect(onSelectTab).toHaveBeenCalledWith('expiring');
  });

  it('render_WhenStalledCardHasNoTab_ShouldBeDisabledAndNotSelectable', () => {
    // Arrange
    const onSelectTab = vi.fn();
    render(<CategoryCards categories={CATEGORIES} activeTab="all" onSelectTab={onSelectTab} />);
    const stalledCard = screen.getAllByTestId('alert-category-card').find((card) => card.getAttribute('data-category') === 'stalled');

    // Act
    fireEvent.click(stalledCard!);

    // Assert
    expect(stalledCard).toBeDisabled();
    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it('render_WhenTabActive_ShouldMarkMatchingCardActive', () => {
    // Arrange & Act
    render(<CategoryCards categories={CATEGORIES} activeTab="sla" onSelectTab={vi.fn()} />);
    const slaCard = screen.getAllByTestId('alert-category-card').find((card) => card.getAttribute('data-category') === 'sla');

    // Assert
    expect(slaCard).toHaveAttribute('data-active', 'true');
  });
});
