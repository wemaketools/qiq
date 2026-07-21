import { QUOTE_OPERATION_CODES } from './quotesApi';

/** Display label per quote workflow operation wire code (`QuoteOperationCodes`, T-020/T-029, PRD 10.4/12.8). */
export const QUOTE_OPERATION_LABELS: Record<string, string> = {
  [QUOTE_OPERATION_CODES.Assign]: 'Assign',
  [QUOTE_OPERATION_CODES.Send]: 'Send',
  [QUOTE_OPERATION_CODES.Revise]: 'Revise',
  [QUOTE_OPERATION_CODES.MarkWon]: 'Mark won',
  [QUOTE_OPERATION_CODES.MarkLost]: 'Mark lost',
  [QUOTE_OPERATION_CODES.Withdraw]: 'Withdraw',
  [QUOTE_OPERATION_CODES.SetCurrent]: 'Set current',
};

export function labelForQuoteOperation(op: string): string {
  return QUOTE_OPERATION_LABELS[op] ?? op;
}
