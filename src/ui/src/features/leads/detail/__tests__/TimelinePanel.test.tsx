import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TimelinePanel from '../TimelinePanel';
import type { TimelineEntryDto } from '../../leadsApi';

const ENTRIES: TimelineEntryDto[] = [
  { type: 'status', at: '2026-02-01T10:00:00Z', actorName: 'Sam RM', title: 'Assign', detail: 'New → Assigned', quoteRef: null },
  { type: 'follow_up', at: '2026-01-30T09:00:00Z', actorName: 'Sam RM', title: 'Follow-up logged', detail: 'Called client', quoteRef: null },
  { type: 'quote_status', at: '2026-01-29T09:00:00Z', actorName: 'Sam RM', title: 'Send', detail: 'Draft → Sent', quoteRef: 'Q-2026-0001' },
  { type: 'note', at: '2026-01-28T09:00:00Z', actorName: 'Sam RM', title: 'Note added', detail: 'Intake note', quoteRef: null },
];

describe('TimelinePanel', () => {
  it('render_WhenEntriesProvided_ShouldRenderNewestFirstWithIconsPerType', () => {
    // Arrange & Act
    render(
      <TimelinePanel
        entries={ENTRIES}
        totalCount={4}
        loading={false}
        loadingMore={false}
        nextFollowUpDate="2026-02-05"
        isNextFollowUpOverdue={false}
        onLoadMore={vi.fn()}
        onLogFollowUp={vi.fn()}
      />,
    );

    // Assert
    const rows = screen.getAllByTestId('timeline-entry');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('Assign');
    expect(rows[2]).toHaveTextContent('Q-2026-0001');
    expect(screen.getByTestId('timeline-entry-icon-status')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-entry-icon-quote_status')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-entry-icon-follow_up')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-entry-icon-note')).toBeInTheDocument();
  });

  it('render_WhenNextFollowUpOverdue_ShouldShowRedBannerWithOverdueChip', () => {
    // Arrange & Act
    render(
      <TimelinePanel
        entries={[]}
        totalCount={0}
        loading={false}
        loadingMore={false}
        nextFollowUpDate="2026-01-01"
        isNextFollowUpOverdue
        onLoadMore={vi.fn()}
        onLogFollowUp={vi.fn()}
      />,
    );

    // Assert
    expect(screen.getByTestId('overdue-chip')).toBeInTheDocument();
    expect(screen.getByTestId('next-follow-up-banner')).toHaveTextContent('2026-01-01');
  });

  it('click_WhenLogFollowUpButtonClicked_ShouldCallOnLogFollowUp', () => {
    // Arrange
    const onLogFollowUp = vi.fn();
    render(
      <TimelinePanel
        entries={[]}
        totalCount={0}
        loading={false}
        loadingMore={false}
        nextFollowUpDate={null}
        isNextFollowUpOverdue={false}
        onLoadMore={vi.fn()}
        onLogFollowUp={onLogFollowUp}
      />,
    );

    // Act
    fireEvent.click(screen.getByTestId('log-follow-up-button'));

    // Assert
    expect(onLogFollowUp).toHaveBeenCalled();
  });

  it('render_WhenMoreEntriesExistThanLoaded_ShouldShowLoadMoreButton', () => {
    // Arrange & Act
    render(
      <TimelinePanel
        entries={ENTRIES.slice(0, 2)}
        totalCount={4}
        loading={false}
        loadingMore={false}
        nextFollowUpDate={null}
        isNextFollowUpOverdue={false}
        onLoadMore={vi.fn()}
        onLogFollowUp={vi.fn()}
      />,
    );

    // Assert
    expect(screen.getByTestId('timeline-load-more')).toBeInTheDocument();
  });

  it('render_WhenAllEntriesLoaded_ShouldHideLoadMoreButton', () => {
    // Arrange & Act
    render(
      <TimelinePanel
        entries={ENTRIES}
        totalCount={4}
        loading={false}
        loadingMore={false}
        nextFollowUpDate={null}
        isNextFollowUpOverdue={false}
        onLoadMore={vi.fn()}
        onLogFollowUp={vi.fn()}
      />,
    );

    // Assert
    expect(screen.queryByTestId('timeline-load-more')).not.toBeInTheDocument();
  });
});
