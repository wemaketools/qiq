interface StubPageProps {
  title: string;
  testId: string;
}

/**
 * Placeholder for a §10.1 route whose real screen lands in a later task. Lazy-loaded per route
 * (see app/router.tsx) so the router shape doesn't need to change when each screen is built.
 */
function StubPage({ title, testId }: StubPageProps) {
  return (
    <div data-testid={testId} className="qiq-card">
      <h2 style={{ fontSize: '16px', marginBottom: 'var(--qiq-space-2)' }}>{title}</h2>
      <p style={{ margin: 0, color: 'var(--qiq-text-secondary)' }}>This screen is not yet implemented.</p>
    </div>
  );
}

export default StubPage;
