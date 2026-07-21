/** Builds the shared workflow-dialog title format (spec FR-41, PRD 12.8): `"{Action} — {ref} · {party}"`. */
export function formatWorkflowDialogTitle(action: string, entityRef: string, partyName: string): string {
  return `${action} — ${entityRef} · ${partyName}`;
}
