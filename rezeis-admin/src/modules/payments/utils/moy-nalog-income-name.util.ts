/** Default income description rendered when the operator leaves the template blank. */
export const DEFAULT_INCOME_DESCRIPTION_TEMPLATE = 'Платеж #{description}';

/**
 * Renders the «Мой Налог» income service name from a small placeholder
 * template. Supported placeholders:
 *   - `{description}` / `{payment_description}` — the human description
 *     (falls back to the payment id when empty)
 *   - `{id}` — the payment id
 *   - `{amount}` — the formatted amount string
 *
 * Kept deliberately simple: we do not have YooKassa invoice/customer data,
 * so only these placeholders are substituted.
 */
export function renderIncomeName(
  template: string | undefined,
  vars: { readonly description: string; readonly id: string; readonly amount: string },
): string {
  const effectiveTemplate =
    typeof template === 'string' && template.trim().length > 0
      ? template
      : DEFAULT_INCOME_DESCRIPTION_TEMPLATE;
  const description = vars.description.trim().length > 0 ? vars.description : vars.id;
  return effectiveTemplate
    .replaceAll('{payment_description}', description)
    .replaceAll('{description}', description)
    .replaceAll('{id}', vars.id)
    .replaceAll('{amount}', vars.amount);
}
