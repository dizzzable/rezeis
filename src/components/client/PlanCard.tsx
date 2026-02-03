import { Check, ShoppingCart } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useState } from 'react';
import type { PlanWithDurations } from '@/api/client.service';

/**
 * PlanCard props interface
 */
interface PlanCardProps {
  plan: PlanWithDurations;
  onPurchase: (plan: PlanWithDurations, durationId: number, price: number, currency: string) => void;
}

/**
 * PlanCard component
 * Displays a plan with duration options and purchase button
 */
export function PlanCard({ plan, onPurchase }: PlanCardProps): React.ReactElement {
  const [selectedDurationId, setSelectedDurationId] = useState<string>(
    plan.durations?.[0]?.id?.toString() || ''
  );

  const selectedDuration = plan.durations?.find(
    (d) => d.id.toString() === selectedDurationId
  );

  const handlePurchase = (): void => {
    if (selectedDuration) {
      const price = selectedDuration.prices?.[0];
      if (price) {
        onPurchase(plan, selectedDuration.id, price.price, price.currency);
      }
    }
  };

  // Features list (mock data based on plan description or defaults)
  const features = [
    'Высокая скорость',
    'Безлимитный трафик',
    'Поддержка 24/7',
  ];

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-xl">{plan.name}</CardTitle>
            <CardDescription className="mt-1.5">
              {plan.description || 'VPN подписка'}
            </CardDescription>
          </div>
          {plan.isActive && <Badge variant="default">Активен</Badge>}
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col">
        {/* Price Display */}
        <div className="mb-4">
          {selectedDuration ? (
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-bold">
                {selectedDuration.prices?.[0]?.price || 0}
              </span>
              <span className="text-muted-foreground">
                {selectedDuration.prices?.[0]?.currency || 'USD'}
              </span>
              <span className="text-sm text-muted-foreground">
                / {selectedDuration.days} дней
              </span>
            </div>
          ) : (
            <span className="text-muted-foreground">Выберите длительность</span>
          )}
        </div>

        {/* Duration Selector */}
        {plan.durations && plan.durations.length > 0 && (
          <div className="mb-4">
            <Select
              value={selectedDurationId}
              onChange={(e) => setSelectedDurationId(e.target.value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Выберите длительность" />
              </SelectTrigger>
              <SelectContent>
                {plan.durations.map((duration) => (
                  <SelectItem
                    key={duration.id}
                    value={duration.id.toString()}
                  >
                    {duration.days} дней - {duration.prices?.[0]?.price || 0} {duration.prices?.[0]?.currency || 'USD'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Features */}
        <ul className="space-y-2 mb-6 flex-1">
          {features.map((feature, index) => (
            <li key={index} className="flex items-center gap-2 text-sm">
              <Check className="h-4 w-4 text-green-500" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>

        {/* Purchase Button */}
        <Button
          className="w-full"
          onClick={handlePurchase}
          disabled={!selectedDuration}
        >
          <ShoppingCart className="mr-2 h-4 w-4" />
          Купить
        </Button>
      </CardContent>
    </Card>
  );
}

export default PlanCard;
