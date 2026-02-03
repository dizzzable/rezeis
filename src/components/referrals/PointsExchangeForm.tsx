import { useState } from 'react';
import { Gift, Ticket, Wifi, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

interface PointsExchangeFormProps {
  availablePoints: number;
  onExchange: (type: 'subscription' | 'discount' | 'traffic', amount: number) => Promise<void>;
  isLoading: boolean;
  className?: string;
}

interface ExchangeOption {
  type: 'subscription' | 'discount' | 'traffic';
  title: string;
  description: string;
  icon: React.ReactNode;
  pointsPerUnit: number;
  unitLabel: string;
  maxUnits: number;
  color: string;
  bgColor: string;
}

const exchangeOptions: ExchangeOption[] = [
  {
    type: 'subscription',
    title: 'Дни подписки',
    description: 'Обменяйте баллы на дополнительные дни подписки',
    icon: <Gift className="h-5 w-5" />,
    pointsPerUnit: 10,
    unitLabel: 'день',
    maxUnits: 30,
    color: 'text-green-600',
    bgColor: 'bg-green-50',
  },
  {
    type: 'discount',
    title: 'Скидка на покупку',
    description: 'Получите скидку на следующую покупку',
    icon: <Ticket className="h-5 w-5" />,
    pointsPerUnit: 5,
    unitLabel: '%',
    maxUnits: 50,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
  },
  {
    type: 'traffic',
    title: 'Дополнительный трафик',
    description: 'Добавьте трафик к вашей подписке',
    icon: <Wifi className="h-5 w-5" />,
    pointsPerUnit: 20,
    unitLabel: 'ГБ',
    maxUnits: 50,
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
  },
];

/**
 * PointsExchangeForm component
 * Allows users to exchange referral points for rewards
 */
export function PointsExchangeForm({
  availablePoints,
  onExchange,
  isLoading,
  className,
}: PointsExchangeFormProps): React.ReactElement {
  const [selectedType, setSelectedType] = useState<'subscription' | 'discount' | 'traffic'>('subscription');
  const [amount, setAmount] = useState('');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const selectedOption = exchangeOptions.find((opt) => opt.type === selectedType)!;
  const pointsNeeded = parseInt(amount || '0', 10) * selectedOption.pointsPerUnit;
  const canExchange = pointsNeeded > 0 && pointsNeeded <= availablePoints;

  const handleExchange = async (): Promise<void> => {
    if (!canExchange) return;
    
    await onExchange(selectedType, pointsNeeded);
    setSuccessMessage(`Успешно обменено ${pointsNeeded} баллов на ${amount} ${selectedOption.unitLabel}!`);
    setAmount('');
    
    setTimeout(() => setSuccessMessage(null), 5000);
  };

  const maxUnits = Math.min(
    Math.floor(availablePoints / selectedOption.pointsPerUnit),
    selectedOption.maxUnits
  );

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gift className="h-5 w-5" />
          Обмен баллов
        </CardTitle>
        <CardDescription>
          Доступно для обмена: <span className="font-medium text-primary">{availablePoints} баллов</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {successMessage && (
          <Alert className="bg-green-50 border-green-200">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-800">{successMessage}</AlertDescription>
          </Alert>
        )}

        {/* Exchange Type Selection */}
        <div className="grid gap-3">
          <Label>Что вы хотите получить?</Label>
          <div className="grid gap-3 md:grid-cols-3">
            {exchangeOptions.map((option) => (
              <button
                key={option.type}
                onClick={() => {
                  setSelectedType(option.type);
                  setAmount('');
                }}
                className={cn(
                  'flex flex-col items-center p-4 rounded-lg border-2 transition-all text-left',
                  selectedType === option.type
                    ? `border-current ${option.color} ${option.bgColor}`
                    : 'border-muted hover:border-muted-foreground/20'
                )}
              >
                <div className={cn('p-2 rounded-full mb-2', option.bgColor, option.color)}>
                  {option.icon}
                </div>
                <span className="font-medium text-sm">{option.title}</span>
                <span className="text-xs text-muted-foreground mt-1">
                  {option.pointsPerUnit} баллов = 1 {option.unitLabel}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Selected Option Details */}
        <div className={cn('p-4 rounded-lg', selectedOption.bgColor)}>
          <p className="text-sm text-muted-foreground">{selectedOption.description}</p>
          <p className="text-sm mt-2">
            Курс обмена: <span className={cn('font-medium', selectedOption.color)}>{selectedOption.pointsPerUnit} баллов</span> за 1 {selectedOption.unitLabel}
          </p>
        </div>

        {/* Amount Input */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="amount">Количество ({selectedOption.unitLabel})</Label>
            <span className="text-sm text-muted-foreground">
              Макс: {maxUnits} {selectedOption.unitLabel}
            </span>
          </div>
          <Input
            id="amount"
            type="number"
            min={1}
            max={maxUnits}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`Введите количество ${selectedOption.unitLabel}`}
          />
        </div>

        {/* Summary */}
        {amount && (
          <div className="p-4 rounded-lg bg-muted space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Будет списано:</span>
              <span className={cn('font-medium', pointsNeeded > availablePoints ? 'text-red-600' : 'text-green-600')}>
                {pointsNeeded} баллов
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Останется:</span>
              <span className="font-medium">{Math.max(0, availablePoints - pointsNeeded)} баллов</span>
            </div>
          </div>
        )}

        {/* Error Message */}
        {amount && pointsNeeded > availablePoints && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Недостаточно баллов. Нужно {pointsNeeded}, доступно {availablePoints}.
            </AlertDescription>
          </Alert>
        )}

        {/* Exchange Button */}
        <Button
          onClick={handleExchange}
          disabled={!canExchange || isLoading}
          className="w-full"
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Обработка...
            </>
          ) : (
            <>
              <Gift className="mr-2 h-4 w-4" />
              Обменять {pointsNeeded > 0 ? `(${pointsNeeded} баллов)` : ''}
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

export default PointsExchangeForm;
