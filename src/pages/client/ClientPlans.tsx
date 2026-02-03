import { useEffect } from 'react';
import { Package, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PlanCard } from '@/components/client';
import { useClientPlans, useClientStore } from '@/stores/client.store';
import type { PlanWithDurations } from '@/api/client.service';

/**
 * ClientPlans page component
 * Displays available plans for purchase
 */
export default function ClientPlans(): React.ReactElement {
  const { plans, isLoading } = useClientPlans();
  const fetchPlans = useClientStore((state) => state.fetchPlans);

  // Fetch plans on mount
  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  const handlePurchase = async (
    plan: PlanWithDurations,
    _durationId: number,
    price: number,
    currency: string
  ): Promise<void> => {
    // For now, just show an alert. In production, this would:
    // 1. Create a payment
    // 2. Redirect to payment gateway
    // 3. Or show payment modal
    alert(`Переход к оплате: ${plan.name} - ${price} ${currency}`);
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Тарифы</h1>
        <p className="text-muted-foreground mt-1">
          Выберите подходящий тарифный план
        </p>
      </div>

      {/* Info Alert */}
      <Alert>
        <Package className="h-4 w-4" />
        <AlertTitle>Специальное предложение</AlertTitle>
        <AlertDescription>
          При покупке подписки на 12 месяцев вы получаете скидку 20%!
        </AlertDescription>
      </Alert>

      {/* Plans Grid */}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="h-[400px]">
              <CardHeader>
                <div className="h-6 w-32 animate-pulse rounded bg-muted" />
                <div className="h-4 w-48 animate-pulse rounded bg-muted mt-2" />
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="h-8 w-24 animate-pulse rounded bg-muted" />
                <div className="space-y-2">
                  {[1, 2, 3].map((j) => (
                    <div key={j} className="h-4 w-full animate-pulse rounded bg-muted" />
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : plans.length === 0 ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Нет доступных тарифов</AlertTitle>
          <AlertDescription>
            В данный момент нет доступных тарифных планов. Попробуйте позже.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} onPurchase={handlePurchase} />
          ))}
        </div>
      )}
    </div>
  );
}
