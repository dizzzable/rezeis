/**
 * BulkRenewalCard Component
 * Component for bulk renewal of multiple subscriptions
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import apiClient from '@/api/client';

/**
 * Subscription interface
 */
interface Subscription {
  id: string;
  plan: { name: string };
  end_date: string;
  status: string;
  device_type?: string;
}

/**
 * Bulk renewal calculation response interface
 */
interface BulkRenewalCalculationResponse {
  totalAmount: number;
  totalDiscount: number;
  finalAmount: number;
}

/**
 * Bulk renewal card props interface
 */
interface BulkRenewalCardProps {
  /** List of subscriptions to renew */
  subscriptions: Subscription[];
  /** Callback when renewal is requested */
  onRenew: (subscriptionIds: string[], total: number) => void;
}

/**
 * BulkRenewalCard Component
 * Allows users to select multiple subscriptions for bulk renewal
 */
export function BulkRenewalCard({ subscriptions, onRenew }: BulkRenewalCardProps): React.ReactElement | null {
  const [selected, setSelected] = useState<string[]>([]);
  const [loading] = useState(false);
  const [price, setPrice] = useState<BulkRenewalCalculationResponse | null>(null);

  const activeSubscriptions = subscriptions.filter((s) => s.status === 'active');

  /**
   * Handle select all toggle
   */
  const handleSelectAll = (): void => {
    if (selected.length === activeSubscriptions.length) {
      setSelected([]);
      setPrice(null);
    } else {
      const allIds = activeSubscriptions.map((s) => s.id);
      setSelected(allIds);
      calculatePrice(allIds);
    }
  };

  /**
   * Handle individual selection toggle
   */
  const handleSelect = async (id: string, checked: boolean): Promise<void> => {
    const newSelected = checked
      ? [...selected, id]
      : selected.filter((s) => s !== id);
    setSelected(newSelected);

    if (newSelected.length > 0) {
      await calculatePrice(newSelected);
    } else {
      setPrice(null);
    }
  };

  /**
   * Calculate bulk renewal price
   */
  const calculatePrice = async (ids: string[]): Promise<void> => {
    try {
      const response = await apiClient.post<BulkRenewalCalculationResponse>(
        '/api/client/subscriptions/enhanced/bulk-renewal/calculate',
        { subscriptionIds: ids }
      );
      setPrice(response.data);
    } catch (error) {
      console.error('Failed to calculate price:', error);
    }
  };

  /**
   * Handle renewal action
   */
  const handleRenew = (): void => {
    if (selected.length === 0 || !price) return;
    onRenew(selected, price.finalAmount);
  };

  if (activeSubscriptions.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Продлить несколько</CardTitle>
          <Button variant="outline" size="sm" onClick={handleSelectAll}>
            {selected.length === activeSubscriptions.length ? 'Снять все' : 'Выбрать все'}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 mb-4">
          {activeSubscriptions.map((sub) => (
            <div
              key={sub.id}
              className="flex items-center justify-between p-3 rounded-lg border"
            >
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={selected.includes(sub.id)}
                  onChange={(e) => handleSelect(sub.id, e.target.checked)}
                />
                <div>
                  <p className="font-medium">{sub.plan.name}</p>
                  <p className="text-sm text-muted-foreground">
                    Истекает: {new Date(sub.end_date).toLocaleDateString()}
                    {sub.device_type && ` • ${sub.device_type}`}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {price && selected.length > 0 && (
          <div className="p-4 bg-muted rounded-lg mb-4">
            <div className="flex justify-between text-sm mb-1">
              <span>Итого:</span>
              <span className="line-through text-muted-foreground">
                {price.totalAmount} ₽
              </span>
            </div>
            <div className="flex justify-between text-sm mb-2">
              <span>Скидка:</span>
              <span className="text-green-600">-{price.totalDiscount} ₽</span>
            </div>
            <div className="flex justify-between font-bold text-lg">
              <span>К оплате:</span>
              <span>{price.finalAmount} ₽</span>
            </div>
          </div>
        )}

        <Button
          className="w-full"
          onClick={handleRenew}
          disabled={selected.length === 0 || loading}
        >
          {loading ? 'Расчёт...' : `Продлить выбранные (${selected.length})`}
        </Button>
      </CardContent>
    </Card>
  );
}

export default BulkRenewalCard;
