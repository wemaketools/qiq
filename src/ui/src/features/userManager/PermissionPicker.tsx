import { formatPermissionCategory, groupPermissionsByCategory, PERMISSION_CATALOG } from './permissionCatalog';

interface PermissionPickerProps {
  selected: string[];
  onChange: (codes: string[]) => void;
  /**
   * Codes the caller may legally grant (their own effective permission set) — checkboxes for any
   * other catalog code are disabled as a basic ceiling affordance (grant-no-higher-than-self,
   * spec F-028/F-031/F-034). This is a UX affordance only: the server remains the sole authority
   * and still validates/rejects an out-of-ceiling grant with `*_PERMISSION_EXCEEDS_CALLER_GRANT`.
   */
  grantableCodes?: string[] | null;
  disabled?: boolean;
}

/**
 * Grouped checkbox tree over the permission catalog (spec FR-13, T-007), organized by category —
 * used by RoleFormPage (role permission set) and GroupDetailPage (group direct permissions).
 */
function PermissionPicker({ selected, onChange, grantableCodes, disabled }: PermissionPickerProps) {
  const groups = groupPermissionsByCategory(PERMISSION_CATALOG);
  const selectedSet = new Set(selected);

  function toggle(code: string, checked: boolean): void {
    if (checked) {
      onChange([...selected, code]);
    } else {
      onChange(selected.filter((existing) => existing !== code));
    }
  }

  return (
    <div data-testid="permission-picker">
      {groups.map(({ category, entries }) => (
        <fieldset key={category} data-testid={`permission-group-${category}`} className="qiq-fieldset">
          <legend>{formatPermissionCategory(category)}</legend>
          <div className="qiq-check-list">
            {entries.map((entry) => {
              const grantable = grantableCodes == null || grantableCodes.includes(entry.code);
              // The accessible name is set explicitly via `aria-label` (exactly `entry.code`, plus
              // the ceiling-affordance suffix when not grantable) rather than derived from the
              // wrapping `<label>`'s content — locators (`getByLabelText`/`getByLabel`) target the
              // code, while the visible text is the friendlier catalog description.
              const accessibleName = grantable ? entry.code : `${entry.code} (exceeds your own grants)`;
              return (
                <label key={entry.code} htmlFor={`permission-${entry.code}`}>
                  <input
                    id={`permission-${entry.code}`}
                    type="checkbox"
                    aria-label={accessibleName}
                    checked={selectedSet.has(entry.code)}
                    disabled={disabled || !grantable}
                    onChange={(event) => toggle(entry.code, event.target.checked)}
                  />
                  <span className="qiq-check-text">
                    <span>
                      {entry.description}
                      {!grantable && ' (exceeds your own grants)'}
                    </span>
                    <span className="qiq-check-code">{entry.code}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

export default PermissionPicker;
