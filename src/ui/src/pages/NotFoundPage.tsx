import EmptyState from '../components/common/EmptyState';

/** 404 — no route matched (spec §10.2 UI states). */
function NotFoundPage() {
  return (
    <div data-testid="not-found-page">
      <EmptyState message="Page not found" />
    </div>
  );
}

export default NotFoundPage;
