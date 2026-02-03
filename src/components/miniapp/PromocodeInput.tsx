/**
 * PromocodeInput Component
 * Input component for entering and applying promocodes during purchase
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useNotificationStore, type NotificationType } from '@/stores/notification.store';
import apiClient from '@/api/client';

/**
 * Promocode input props interface
 */
interface PromocodeInputProps {
  /** Callback when promocode is successfully applied */
  onPromocodeApplied: (promocode: {
    code: string;
    discount?: number;
    reward?: { type: string; value: number; description: string };
  }) => void;
  /** Optional plan ID for validation */
  planId?: string;
  /** Optional amount for validation */
  amount?: number;
  /** Whether the input is disabled */
  disabled?: boolean;
}

/**
 * Promocode activation response interface
 */
interface PromocodeActivationResponse {
  success: boolean;
  error?: string;
  activation?: {
    reward_applied?: { type: string; value: number; description: string };
  };
}

/**
 * PromocodeInput Component
 * Allows users to enter and apply promocodes during purchase
 */
export function PromocodeInput({
  onPromocodeApplied,
  planId: _planId,
  amount: _amount,
  disabled = false,
}: PromocodeInputProps): React.ReactElement {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addNotification = useNotificationStore((state) => state.addNotification);

  /**
   * Apply the promocode
   */
  const handleApply = async (): Promise<void> => {
    if (!code.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.post<PromocodeActivationResponse>(
        '/api/client/promocode/apply',
        { code }
      );

      if (!response.data.success) {
        setError(response.data.error || 'Не удалось применить промокод');
        return;
      }

      setApplied(true);
      onPromocodeApplied({
        code,
        reward: response.data.activation?.reward_applied,
      });

      addNotification({
        type: 'success' as NotificationType,
        title: 'Промокод активирован!',
        message: response.data.activation?.reward_applied?.description || 'Скидка применена',
      });
    } catch (err) {
      setError('Ошибка применения промокода');
    } finally {
      setLoading(false);
    }
  };

  // Show applied state
  if (applied) {
    return (
      <Card className="bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800">
        <CardContent className="pt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-green-800 dark:text-green-200">
                Промокод {code} активирован
              </p>
              <p className="text-sm text-green-600 dark:text-green-400">Скидка применена</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setApplied(false);
                setCode('');
              }}
            >
              Изменить
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Промокод</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Input
            placeholder="Введите промокод"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            disabled={disabled || loading}
            className="font-mono"
          />
          <Button
            onClick={handleApply}
            disabled={!code.trim() || disabled || loading}
          >
            {loading ? 'Применение...' : 'Применить'}
          </Button>
        </div>
        {error && <p className="text-sm text-red-500 mt-2">{error}</p>}
        <p className="text-xs text-muted-foreground mt-2">
          У вас есть промокод? Введите его для получения скидки или бонуса.
        </p>
      </CardContent>
    </Card>
  );
}

export default PromocodeInput;
