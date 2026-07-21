import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  message: string;
  actions?: ReactNode;
}

/** Shared empty-state pattern (UI Standards §14.4): icon, plain-language message, primary action(s). */
function EmptyState({ icon, message, actions }: EmptyStateProps) {
  return (
    <div data-testid="empty-state" className="qiq-empty">
      {icon && <div data-testid="empty-state-icon">{icon}</div>}
      <p style={{ margin: 0 }}>{message}</p>
      {actions && (
        <div data-testid="empty-state-actions" style={{ display: 'flex', gap: 'var(--qiq-space-3)' }}>
          {actions}
        </div>
      )}
    </div>
  );
}

export default EmptyState;
