/**
 * TrialBanner Component
 * Promotional banner for trial subscriptions
 */

import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import apiClient from '@/api/client';

/**
 * Trial banner props interface
 */
interface TrialBannerProps {
  /** User ID for trial activation */
  userId?: string;
  /** Callback when trial is successfully activated */
  onTrialActivated?: (subscription: { id: string; plan: { name: string } }) => void;
}

/**
 * Trial creation response interface
 */
interface TrialResponse {
  success: boolean;
  subscription?: {
    id: string;
    plan: { name: string };
  };
}

/**
 * TrialBanner Component
 * Displays a promotional banner for trial subscriptions
 */
export function TrialBanner({ onTrialActivated }: TrialBannerProps): React.ReactElement {
  const navigate = useNavigate();

  /**
   * Handle trial activation
   */
  const handleActivateTrial = async (): Promise<void> => {
    try {
      const response = await apiClient.post<TrialResponse>('/api/client/subscriptions/enhanced/trial');

      if (response.data.success && response.data.subscription) {
        onTrialActivated?.(response.data.subscription);
        navigate('/client/subscriptions');
      }
    } catch (error) {
      console.error('Failed to activate trial:', error);
    }
  };

  return (
    <Card className="bg-gradient-to-r from-purple-500 to-pink-500 text-white border-0">
      <CardContent className="pt-6 pb-6">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <div>
            <h3 className="text-xl font-bold mb-2">Попробуйте бесплатно!</h3>
            <p className="text-white/90 mb-4">
              Получите 3 дня premium-доступа к VPN бесплатно. Никаких обязательств.
            </p>
            <div className="flex items-center gap-4 text-sm">
              <span className="flex items-center gap-1">
                <span className="text-lg">🚀</span> Без ограничений
              </span>
              <span className="flex items-center gap-1">
                <span className="text-lg">🔒</span> Безопасно
              </span>
              <span className="flex items-center gap-1">
                <span className="text-lg">⚡</span> Быстрый старт
              </span>
            </div>
          </div>
          <Button
            onClick={handleActivateTrial}
            className="bg-white text-purple-600 hover:bg-white/90 font-semibold px-6"
          >
            Активировать бесплатно
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default TrialBanner;
