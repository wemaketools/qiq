interface SkeletonTableProps {
  rows?: number;
  columns?: number;
}

/** Loading placeholder for tables/cards (UI Standards §14.5): avoids layout shift on data arrival. */
function SkeletonTable({ rows = 5, columns = 4 }: SkeletonTableProps) {
  return (
    <div data-testid="skeleton-table" role="status" aria-label="Loading" aria-busy="true">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} style={{ display: 'flex', gap: 'var(--qiq-space-3)', padding: 'var(--qiq-space-2) 0' }}>
          {Array.from({ length: columns }, (_, columnIndex) => (
            <span key={columnIndex} className="qiq-skeleton" style={{ flex: 1, height: '14px' }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default SkeletonTable;
