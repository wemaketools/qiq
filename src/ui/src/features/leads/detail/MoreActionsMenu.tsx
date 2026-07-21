import { useEffect, useRef, useState } from 'react';
import type { LeadDetailDto } from '../leadsApi';
import { labelForOperation } from './leadOperations';

interface MoreActionsMenuProps {
  /** Already deduped/primary-excluded (`moreActionsOperations`) legal operations for this lead. */
  operations: string[];
  lead: LeadDetailDto;
  onSelect: (op: string) => void;
}

/**
 * Lead Detail header's "More actions" menu (spec FR-17/FR-41, PRD 12.5, AC-016): renders one entry
 * per server-computed legal operation and nothing else — illegal/unpermitted operations are simply
 * absent from `lead.availableOperations` (never rendered-then-disabled), so this component has no
 * disabled-state branch to get wrong. Renders nothing at all when no non-primary operations remain
 * (a closed lead, or one whose only legal operation is already the primary action). The open menu is
 * a `.qiq-menu` overlay anchored under the trigger (same dropdown system as the shell's user-card
 * menu), never an inline expansion that reflows the header.
 */
function MoreActionsMenu({ operations, lead, onSelect }: MoreActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  if (operations.length === 0) {
    return null;
  }

  return (
    <div data-testid="more-actions-menu" ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        data-testid="more-actions-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        More actions
      </button>
      {open && (
        <ul role="menu" className="qiq-menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, whiteSpace: 'nowrap' }}>
          {operations.map((op) => (
            <li key={op} role="none">
              <button
                type="button"
                role="menuitem"
                data-testid={`more-action-${op}`}
                onClick={() => {
                  setOpen(false);
                  onSelect(op);
                }}
              >
                {labelForOperation(op, lead)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default MoreActionsMenu;
