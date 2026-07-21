import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastVariant = 'success' | 'error';

interface ToastEntry {
  id: number;
  variant: ToastVariant;
  message: string;
}

interface ToastContextValue {
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 4000;

/**
 * Toast provider (docs/QuoteIQ_UI_Standards.md §14.1): transient success/error confirmations,
 * auto-dismissed after ~4s, stacked top-right, announced via `aria-live`. Never used for
 * validation errors (those render inline per §10.2).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (variant: ToastVariant, message: string) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current, { id, variant, message }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      showSuccess: (message: string) => push('success', message),
      showError: (message: string) => push('error', message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div data-testid="toast-viewport" role="region" aria-live="polite" className="qiq-toasts">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            data-testid={toast.variant === 'success' ? 'toast-success' : 'toast-error'}
            role="status"
            className={`qiq-toast qiq-toast--${toast.variant}`}
          >
            {toast.message}
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

/**
 * Provider-optional variant of {@link useToast}: returns null instead of throwing when no
 * <see cref="ToastProvider"/> is above in the tree. Used by leaf components (e.g. the export
 * affordances, T-039) that may be rendered in isolation (component tests) where wrapping a provider
 * would be incidental ceremony; the real app always mounts a <see cref="ToastProvider"/> at the root
 * (App.tsx), so users still get the toast.
 */
export function useOptionalToast(): ToastContextValue | null {
  return useContext(ToastContext);
}
