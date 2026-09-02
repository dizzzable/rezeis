import { PromocodeRewardType, WheelSectorKind } from '@prisma/client';

import { MAX_DISCOUNT_PERCENT } from '../../common/utils/discount.util';

/**
 * Whether a sector can actually pay what it promises.
 *
 * ── Why this is checked on the way IN ─────────────────────────────────────
 *
 * The draw already refuses to offer a sector it cannot settle — a KEY sector
 * with no pool is excluded as UNCONFIGURED — and that is the right behaviour
 * at spin time, because the alternative is charging somebody for a prize that
 * cannot be handed over. But it is a silent behaviour: the operator sees a
 * sector on the wheel, sets it to 25 %, and it simply never comes up. So the
 * same conditions are checked when the sector is SAVED, where they can be
 * said out loud.
 */

export interface SectorDraft {
  readonly kind: WheelSectorKind;
  readonly weight: number;
  readonly amount: number;
  readonly keyPoolId: string | null;
  readonly promoRewardType: PromocodeRewardType | null;
  readonly promoPlanId: string | null;
  readonly promoLifetime: number | null;
  readonly manualInstructions: string | null;
  readonly maxWinsPerUser: number | null;
  readonly maxWinsTotal: number | null;
}

/** One thing wrong with a sector, in the operator's language. */
export type SectorProblem = { readonly field: string; readonly message: string };

export function validateSector(draft: SectorDraft): readonly SectorProblem[] {
  const problems: SectorProblem[] = [];

  if (!Number.isInteger(draft.weight) || draft.weight < 0) {
    problems.push({ field: 'weight', message: 'Вес — целое число не меньше нуля' });
  }

  switch (draft.kind) {
    case WheelSectorKind.NOTHING:
      // Nothing to give, so nothing to configure. Ceilings on the loss sector
      // are meaningless — it is deliberately exempt from them — and a ceiling
      // an operator sets and the draw ignores is worse than one they cannot
      // set at all.
      if (draft.maxWinsPerUser !== null || draft.maxWinsTotal !== null) {
        problems.push({
          field: 'maxWinsPerUser',
          message: 'У сектора «не повезло» не бывает лимитов: он должен оставаться доступным всем',
        });
      }
      break;

    case WheelSectorKind.POINTS:
    case WheelSectorKind.SPINS:
    case WheelSectorKind.DAYS:
    case WheelSectorKind.TRAFFIC:
      if (!Number.isInteger(draft.amount) || draft.amount <= 0) {
        problems.push({ field: 'amount', message: 'Нужно указать сколько выдавать' });
      }
      break;

    case WheelSectorKind.DISCOUNT:
      if (!Number.isInteger(draft.amount) || draft.amount <= 0) {
        problems.push({ field: 'amount', message: 'Нужно указать процент скидки' });
      } else if (draft.amount > MAX_DISCOUNT_PERCENT) {
        // The ceiling pricing actually applies. A stored 100 would be a number
        // no checkout could ever spend.
        problems.push({
          field: 'amount',
          message: `Скидка не может быть больше ${MAX_DISCOUNT_PERCENT} %`,
        });
      }
      break;

    case WheelSectorKind.PROMOCODE:
      if (draft.promoRewardType === PromocodeRewardType.SUBSCRIPTION) {
        if (draft.promoPlanId === null) {
          problems.push({ field: 'promoPlanId', message: 'Код на подписку требует тарифа' });
        }
      }
      if (
        draft.promoRewardType === PromocodeRewardType.PERSONAL_DISCOUNT ||
        draft.promoRewardType === PromocodeRewardType.PURCHASE_DISCOUNT
      ) {
        if (draft.amount > MAX_DISCOUNT_PERCENT) {
          problems.push({
            field: 'amount',
            message: `Скидка не может быть больше ${MAX_DISCOUNT_PERCENT} %`,
          });
        }
      }
      if (!Number.isInteger(draft.amount) || draft.amount <= 0) {
        problems.push({ field: 'amount', message: 'Нужно указать номинал промокода' });
      }
      if (draft.promoLifetime !== null && (!Number.isInteger(draft.promoLifetime) || draft.promoLifetime <= 0)) {
        problems.push({ field: 'promoLifetime', message: 'Срок жизни — целое число дней' });
      }
      break;

    case WheelSectorKind.KEY:
      if (draft.keyPoolId === null) {
        // Without a pool the draw excludes it as UNCONFIGURED, and the sector
        // sits on the wheel never coming up with no explanation anywhere.
        problems.push({ field: 'keyPoolId', message: 'Выберите пул ключей' });
      }
      if (draft.maxWinsPerUser !== null && draft.maxWinsPerUser < 1) {
        problems.push({ field: 'maxWinsPerUser', message: 'Лимит на человека — от одного' });
      }
      break;

    case WheelSectorKind.MANUAL:
      if (draft.manualInstructions === null || draft.manualInstructions.trim() === '') {
        // The instruction is what the operator reads weeks later, in a queue,
        // deciding what "1000 ₽" was supposed to mean.
        problems.push({
          field: 'manualInstructions',
          message: 'Опишите, что оператор должен сделать: он прочитает это в очереди',
        });
      }
      break;
  }

  if (draft.maxWinsTotal !== null && (!Number.isInteger(draft.maxWinsTotal) || draft.maxWinsTotal < 1)) {
    problems.push({ field: 'maxWinsTotal', message: 'Общий лимит — от одного' });
  }
  if (
    draft.kind !== WheelSectorKind.NOTHING &&
    draft.maxWinsPerUser !== null &&
    (!Number.isInteger(draft.maxWinsPerUser) || draft.maxWinsPerUser < 1)
  ) {
    problems.push({ field: 'maxWinsPerUser', message: 'Лимит на человека — от одного' });
  }

  return problems;
}
