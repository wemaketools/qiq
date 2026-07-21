import { useEffect, useState } from 'react';

export interface AssigneeOption {
  id: number;
  label: string;
}

export interface AssigneeSelectProps {
  id: string;
  label: string;
  /** The currently selected user, or `null` when the role is unassigned. */
  value: AssigneeOption | null;
  required?: boolean;
  disabled?: boolean;
  /** Shown inline under the control, and marks it `aria-invalid` (UI Standards §10.2). */
  error?: string;
  /** Loads the full eligible-user list once on mount (the dialogs mount this fresh per open). */
  loadOptions: () => Promise<AssigneeOption[]>;
  /** `null` means the empty option ("Select a user…" / "Unassigned") was chosen. */
  onChange: (option: AssigneeOption | null) => void;
  testId: string;
}

/**
 * Plain dropdown over a role's eligible users, used by every workflow dialog's user picker
 * (Assign/Reassign roles, Send to underwriting's owner, Request pricing approval's approver,
 * quote role assignment). Replaces the earlier type-ahead `SearchSelect`: the eligible-user
 * endpoints return the full uncapped list per role (`EligibleAssigneeReader`), which is a small
 * bounded set within one tenant, so a native select is simpler — matching `BulkReassignDialog`'s
 * existing owner picker. Required pickers get an empty "Select a user…" placeholder; optional
 * ones get a real "Unassigned" choice (spec FR-35's clear semantics). A pre-filled value that is
 * missing from the loaded list (e.g. the current owner lost eligibility) is kept as an extra
 * option so the control always displays the actual current assignment.
 */
function AssigneeSelect({ id, label, value, required, disabled, error, loadOptions, onChange, testId }: AssigneeSelectProps) {
  const [options, setOptions] = useState<AssigneeOption[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadOptions()
      .then((found) => {
        if (!cancelled) {
          setOptions(found);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOptions([]);
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadOptions is a bound API call, stable per mount; the list is fetched once per dialog open.
  }, []);

  const loading = options === null;
  const valueInOptions = value !== null && (options ?? []).some((option) => option.id === value.id);

  return (
    <div data-testid={testId}>
      <label htmlFor={id}>
        {label}
        {required ? ' *' : ''}
      </label>
      <select
        id={id}
        name={id}
        data-testid={`${testId}-select`}
        value={value !== null ? String(value.id) : ''}
        disabled={disabled || loading}
        aria-invalid={error ? true : undefined}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === '') {
            onChange(null);
            return;
          }
          const picked = (options ?? []).find((option) => String(option.id) === raw) ?? (value !== null && String(value.id) === raw ? value : null);
          if (picked !== null) {
            onChange(picked);
          }
        }}
      >
        <option value="">{loading ? 'Loading users…' : required ? 'Select a user…' : 'Unassigned'}</option>
        {value !== null && !valueInOptions && <option value={String(value.id)}>{value.label}</option>}
        {(options ?? []).map((option) => (
          <option key={option.id} value={String(option.id)}>
            {option.label}
          </option>
        ))}
      </select>
      {loadFailed && (
        <p role="alert" data-testid={`${testId}-load-error`}>
          Eligible users could not be loaded.
        </p>
      )}
      {error && (
        <p role="alert" className="qiq-field-error" data-testid="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export default AssigneeSelect;
