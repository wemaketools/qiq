import type { Locator, Page } from '@playwright/test';

/**
 * Picks a user in an `AssigneeSelect` dropdown (`src/ui/src/components/common/AssigneeSelect.tsx`,
 * rendered as `{testId}-select`) by matching an option label fragment. Waits for the option to be
 * loaded first — the control fetches its eligible-user list on mount and is disabled until then.
 */
export async function selectAssignee(scope: Page | Locator, testId: string, nameFragment: string): Promise<void> {
  const select = scope.getByTestId(`${testId}-select`);
  const option = select.locator('option', { hasText: nameFragment }).first();
  await option.waitFor({ state: 'attached' });
  const value = await option.getAttribute('value');
  await select.selectOption(value ?? '');
}

/** Picks the first real (non-placeholder) user option in an `AssigneeSelect` dropdown. */
export async function selectFirstAssignee(scope: Page | Locator, testId: string): Promise<void> {
  const select = scope.getByTestId(`${testId}-select`);
  const option = select.locator('option:not([value=""])').first();
  await option.waitFor({ state: 'attached' });
  const value = await option.getAttribute('value');
  await select.selectOption(value ?? '');
}
