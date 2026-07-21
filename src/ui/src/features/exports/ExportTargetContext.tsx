import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ExportFormat } from './exportsApi';

/**
 * The current page's primary-table export descriptor (spec FR-52/FR-65, T-039). A list/dashboard page
 * that has a primary exportable table registers one via {@link useRegisterExportTarget}; the TopBar
 * Export action renders only while a target is registered and exports that table. Pages without a
 * primary table (e.g. a form) register nothing, so the TopBar Export action is simply absent there —
 * the resolution of this task's flagged "current page's primary table" ambiguity.
 */
export interface ExportTarget {
  buildPath: (format: ExportFormat) => string;
  fileNameBase: string;
}

interface ExportTargetContextValue {
  target: ExportTarget | null;
  setTarget: (target: ExportTarget | null) => void;
}

const ExportTargetContext = createContext<ExportTargetContextValue | null>(null);

export function ExportTargetProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ExportTarget | null>(null);
  const value = useMemo<ExportTargetContextValue>(() => ({ target, setTarget }), [target]);
  return <ExportTargetContext.Provider value={value}>{children}</ExportTargetContext.Provider>;
}

/** TopBar reads the active target (null when the current page has no primary exportable table). */
export function useExportTarget(): ExportTarget | null {
  return useContext(ExportTargetContext)?.target ?? null;
}

/**
 * Registers <paramref name="target"/> as the current page's primary export while the calling component
 * is mounted, clearing it on unmount so navigating to a table-less page removes the TopBar Export
 * action. Pass null when the caller conditionally has no exportable table (e.g. lacking the export
 * permission).
 */
export function useRegisterExportTarget(target: ExportTarget | null): void {
  const ctx = useContext(ExportTargetContext);
  const buildPath = target?.buildPath;
  const fileNameBase = target?.fileNameBase;

  useEffect(() => {
    if (!ctx) {
      return;
    }
    ctx.setTarget(buildPath && fileNameBase ? { buildPath, fileNameBase } : null);
    return () => ctx.setTarget(null);
    // ctx is stable for the provider's lifetime; re-register whenever the builder identity or base changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildPath, fileNameBase]);
}
