import type { PurchaseChannel } from '@prisma/client';

import type { FaqService } from '../../faq/services/faq.service';
import type { PlanCatalogPlanInterface, PlanCatalogQueryContextInterface } from '../../plans/interfaces/plan-catalog.interface';
import type { PlanCatalogService } from '../../plans/services/plan-catalog.service';

/**
 * The two public facts an AI assistant may look up: the plans on sale and the
 * FAQ. Shared by the operator's own chat (`AiChatService`) and the assistant
 * that answers support tickets (`SupportAiResponderService`), so both read the
 * catalogue the same way and neither can grow a field the other leaks.
 *
 * Both answer a JSON string the model reads, and throw when the lookup fails.
 * The callers turn that into an `{ error }` the model reads: a failed lookup is
 * something to tell the client about, not a reason to drop the whole answer.
 */

/** The web catalogue, as the model reads it: names, limits and prices. */
export async function describeTariffsForModel(planCatalog: PlanCatalogService): Promise<string> {
  const query: PlanCatalogQueryContextInterface = { channel: 'WEB' as PurchaseChannel };
  const plans: readonly PlanCatalogPlanInterface[] = await planCatalog.getCatalogPlans(query);
  return JSON.stringify(
    plans.map((p) => ({
      name: p.name,
      description: p.description,
      type: p.type,
      trafficLimit: p.trafficLimit,
      deviceLimit: p.deviceLimit,
      isTrial: p.isTrial,
      trialFree: p.trialFree,
      durations: p.durations.map((d) => ({
        days: d.days,
        prices: d.prices.map((pr) => ({
          price: pr.price,
          currency: pr.currency,
          gatewayType: pr.gatewayType,
        })),
      })),
      displayPrices: p.displayPrices.map((dp) => ({
        price: dp.price,
        currency: dp.currency,
        days: dp.days,
      })),
    })),
  );
}

/** The active FAQ, optionally in one language: question and answer only. */
export async function describeFaqForModel(faq: FaqService, locale?: string): Promise<string> {
  const items = await faq.getPublicFaq(locale ?? null);
  return JSON.stringify(items.map((item) => ({ question: item.question, answer: item.answer })));
}
