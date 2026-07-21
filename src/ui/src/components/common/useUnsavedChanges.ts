import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';

/**
 * Unsaved-changes navigation guard (UI Standards §10.4): prompts before discarding input when
 * navigating away from a dirty form/dialog, both for in-app navigation (react-router `useBlocker`)
 * and for browser close/refresh/external navigation (`beforeunload`).
 *
 * @param isDirty true while the form/dialog has unsaved input.
 * @returns true while an in-app navigation is blocked awaiting the user's confirm/cancel choice.
 */
export function useUnsavedChanges(isDirty: boolean): { isBlocked: boolean; confirm: () => void; cancel: () => void } {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => isDirty && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      if (isDirty) {
        event.preventDefault();
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  return {
    isBlocked: blocker.state === 'blocked',
    confirm: () => {
      if (blocker.state === 'blocked') {
        blocker.proceed();
      }
    },
    cancel: () => {
      if (blocker.state === 'blocked') {
        blocker.reset();
      }
    },
  };
}
