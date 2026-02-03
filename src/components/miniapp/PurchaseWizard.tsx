/**
 * PurchaseWizard Component
 * Step-by-step purchase wizard for subscriptions
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import apiClient from '@/api/client';
import { DeviceSelector } from './DeviceSelector';
import { PromocodeInput } from './PromocodeInput';

/**
 * Plan duration interface
 */
interface PlanDuration {
  id: string;
  days: number;
  price: number;
  discountPercent: number;
  description?: string;
}

/**
 * Plan interface
 */
interface Plan {
  id: string;
  name: string;
  description: string;
  basePrice: number;
  trafficLimitGb: number;
  durations: PlanDuration[];
  subscriptionCount?: number;
}

/**
 * Payment creation response interface
 */
interface PaymentResponse {
  paymentUrl: string;
  transactionId: string;
}

/**
 * Step type
 */
type Step = 'plan' | 'duration' | 'device' | 'promocode' | 'payment';

/**
 * Purchase wizard props interface
 */
interface PurchaseWizardProps {
  /** Available plans */
  plans: Plan[];
  /** Callback when purchase is complete */
  onComplete: (paymentUrl: string, transactionId: string) => void;
  /** Callback when purchase is cancelled */
  onCancel: () => void;
}

/**
 * Step information
 */
const steps: { id: Step; label: string }[] = [
  { id: 'plan', label: 'Тариф' },
  { id: 'duration', label: 'Срок' },
  { id: 'device', label: 'Устройства' },
  { id: 'promocode', label: 'Промокод' },
  { id: 'payment', label: 'Оплата' },
];

/**
 * PurchaseWizard Component
 * A step-by-step wizard for purchasing subscriptions
 */
export function PurchaseWizard({ plans, onComplete, onCancel }: PurchaseWizardProps): React.ReactElement {
  const [currentStep, setCurrentStep] = useState<Step>('plan');
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<PlanDuration | null>(null);
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [appliedPromocode, setAppliedPromocode] = useState<{
    code: string;
    discount?: number;
    reward?: { type: string; value: number; description: string };
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const currentStepIndex = steps.findIndex((s) => s.id === currentStep);

  /**
   * Move to next step
   */
  const handleNext = (): void => {
    const nextIndex = currentStepIndex + 1;
    if (nextIndex < steps.length) {
      setCurrentStep(steps[nextIndex].id);
    }
  };

  /**
   * Move to previous step
   */
  const handleBack = (): void => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex >= 0) {
      setCurrentStep(steps[prevIndex].id);
    }
  };

  /**
   * Process payment
   */
  const handlePayment = async (): Promise<void> => {
    if (!selectedPlan || !selectedDuration) return;

    setLoading(true);
    try {
      const response = await apiClient.post<PaymentResponse>(
        '/api/client/payments/create',
        {
          planId: selectedPlan.id,
          durationId: selectedDuration.id,
          deviceTypes: selectedDevices,
          promocode: appliedPromocode?.code,
        }
      );

      if (response.data.paymentUrl) {
        onComplete(response.data.paymentUrl, response.data.transactionId);
      }
    } catch (error) {
      console.error('Payment failed:', error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Check if current step is complete
   */
  const canProceed = (): boolean => {
    switch (currentStep) {
      case 'plan':
        return !!selectedPlan;
      case 'duration':
        return !!selectedDuration;
      case 'device':
        return selectedDevices.length > 0;
      case 'promocode':
        return true; // Promocode is optional
      case 'payment':
        return true;
      default:
        return false;
    }
  };

  return (
    <Card className="w-full max-w-2xl mx-auto">
      {/* Step indicator */}
      <div className="flex items-center justify-between p-4 border-b">
        {steps.map((step, index) => (
          <div key={step.id} className="flex items-center">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                index <= currentStepIndex
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {index + 1}
            </div>
            <span
              className={`ml-2 text-sm hidden sm:inline ${
                index <= currentStepIndex ? 'font-medium' : 'text-muted-foreground'
              }`}
            >
              {step.label}
            </span>
            {index < steps.length - 1 && (
              <div className="w-8 sm:w-16 h-0.5 bg-muted mx-2 hidden sm:block" />
            )}
          </div>
        ))}
      </div>

      <CardContent className="p-6">
        {/* Plan selection */}
        {currentStep === 'plan' && (
          <div className="space-y-3">
            <h3 className="text-lg font-semibold mb-4">Выберите тариф</h3>
            {plans.map((plan) => (
              <button
                key={plan.id}
                type="button"
                onClick={() => {
                  setSelectedPlan(plan);
                  handleNext();
                }}
                className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                  selectedPlan?.id === plan.id
                    ? 'border-primary bg-primary/5'
                    : 'border-muted hover:border-primary/50'
                }`}
              >
                <div className="flex justify-between">
                  <div>
                    <p className="font-semibold">{plan.name}</p>
                    <p className="text-sm text-muted-foreground">{plan.description}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold">от {plan.basePrice} ₽</p>
                    <p className="text-sm text-muted-foreground">
                      {plan.trafficLimitGb} ГБ трафика
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Duration selection */}
        {currentStep === 'duration' && selectedPlan && (
          <div className="space-y-3">
            <h3 className="text-lg font-semibold mb-4">Выберите срок</h3>
            {selectedPlan.durations.map((duration) => (
              <button
                key={duration.id}
                type="button"
                onClick={() => {
                  setSelectedDuration(duration);
                  handleNext();
                }}
                className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                  selectedDuration?.id === duration.id
                    ? 'border-primary bg-primary/5'
                    : 'border-muted hover:border-primary/50'
                }`}
              >
                <div className="flex justify-between">
                  <div>
                    <p className="font-semibold">{duration.days} дней</p>
                    <p className="text-sm text-muted-foreground">{duration.description}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold">{duration.price} ₽</p>
                    {duration.discountPercent > 0 && (
                      <p className="text-sm text-green-600">
                        -{duration.discountPercent}% экономия
                      </p>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Device selection */}
        {currentStep === 'device' && (
          <DeviceSelector
            quantity={selectedPlan?.subscriptionCount || 1}
            selected={selectedDevices as ('ANDROID' | 'IPHONE' | 'WINDOWS' | 'MAC')[]}
            onChange={(devices) => setSelectedDevices(devices)}
          />
        )}

        {/* Promocode */}
        {currentStep === 'promocode' && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">У вас есть промокод?</h3>
            <PromocodeInput
              onPromocodeApplied={setAppliedPromocode}
              planId={selectedPlan?.id}
            />
          </div>
        )}

        {/* Payment summary */}
        {currentStep === 'payment' && selectedPlan && selectedDuration && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Подтверждение покупки</h3>

            <div className="p-4 bg-muted rounded-lg space-y-2">
              <div className="flex justify-between">
                <span>Тариф:</span>
                <span className="font-medium">{selectedPlan.name}</span>
              </div>
              <div className="flex justify-between">
                <span>Срок:</span>
                <span className="font-medium">{selectedDuration.days} дней</span>
              </div>
              <div className="flex justify-between">
                <span>Устройства:</span>
                <span className="font-medium">{selectedDevices.length}</span>
              </div>
              {appliedPromocode && (
                <div className="flex justify-between text-green-600">
                  <span>Промокод {appliedPromocode.code}:</span>
                  <span className="font-medium">
                    {appliedPromocode.reward?.description || 'Применён'}
                  </span>
                </div>
              )}
              <div className="border-t pt-2 mt-2">
                <div className="flex justify-between text-lg font-bold">
                  <span>Итого к оплате:</span>
                  <span>{selectedDuration.price} ₽</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex justify-between mt-6">
          <Button variant="outline" onClick={onCancel}>
            Отмена
          </Button>
          <div className="flex gap-2">
            {currentStepIndex > 0 && (
              <Button variant="outline" onClick={handleBack}>
                Назад
              </Button>
            )}
            {currentStepIndex < steps.length - 1 && (
              <Button onClick={handleNext} disabled={!canProceed()}>
                Далее
              </Button>
            )}
            {currentStep === 'payment' && (
              <Button onClick={handlePayment} disabled={!canProceed() || loading}>
                {loading ? 'Оплата...' : 'Оплатить'}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default PurchaseWizard;
