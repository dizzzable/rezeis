import { Target, MousePointer, TrendingUp, ArrowRightLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface ConversionStats {
  totalClicks: number;
  totalUniqueClicks: number;
  totalConversions: number;
  totalEarnings: number;
  conversionRate: number;
  dailyStats: Array<{
    date: string;
    clicks: number;
    uniqueClicks: number;
    conversions: number;
    conversionRate: number;
    earnings: number;
  }>;
  periodDays: number;
}

interface PartnerConversionStatsProps {
  stats: ConversionStats;
  isLoading: boolean;
  className?: string;
}

/**
 * Format currency
 */
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format number with commas
 */
function formatNumber(num: number): string {
  return new Intl.NumberFormat('ru-RU').format(num);
}

/**
 * Stat item component
 */
function StatItem({
  icon,
  label,
  value,
  subValue,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
  color: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
      <div className={cn('p-2 rounded-full', color)}>{icon}</div>
      <div>
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
        {subValue && <div className="text-xs text-muted-foreground mt-1">{subValue}</div>}
      </div>
    </div>
  );
}

/**
 * PartnerConversionStats component
 * Displays conversion statistics for the partner
 */
export function PartnerConversionStats({
  stats,
  isLoading,
  className,
}: PartnerConversionStatsProps): React.ReactElement {
  if (isLoading) {
    return (
      <Card className={className}>
        <CardContent className="p-6">
          <div className="h-[200px] animate-pulse bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }

  const { totalClicks, totalUniqueClicks, totalConversions, totalEarnings, conversionRate } = stats;

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Target className="h-5 w-5" />
            Статистика конверсии
          </CardTitle>
          <Badge variant="outline">{stats.periodDays} дней</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Main Stats Grid */}
        <div className="grid gap-3 sm:grid-cols-2">
          <StatItem
            icon={<MousePointer className="h-5 w-5 text-blue-600" />}
            label="Переходов"
            value={formatNumber(totalClicks)}
            subValue={`${formatNumber(totalUniqueClicks)} уникальных`}
            color="bg-blue-100"
          />
          <StatItem
            icon={<TrendingUp className="h-5 w-5 text-green-600" />}
            label="Конверсий"
            value={formatNumber(totalConversions)}
            subValue={`${formatCurrency(totalEarnings)} заработано`}
            color="bg-green-100"
          />
        </div>

        {/* Conversion Rate */}
        <div className="p-4 rounded-lg bg-gradient-to-r from-primary/5 to-primary/10 border">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5 text-primary" />
              <span className="font-medium">Конверсия</span>
            </div>
            <span className="text-2xl font-bold text-primary">{conversionRate.toFixed(1)}%</span>
          </div>
          <Progress value={conversionRate} max={100} className="h-3" />
          <p className="text-sm text-muted-foreground mt-2">
            {conversionRate > 5
              ? 'Отличный показатель конверсии!'
              : conversionRate > 2
              ? 'Хороший показатель. Есть потенциал для роста.'
              : 'Конверсия ниже среднего. Попробуйте улучшить продвижение.'}
          </p>
        </div>

        {/* Daily Breakdown Summary */}
        {stats.dailyStats.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Последние 7 дней</h4>
            <div className="space-y-2">
              {stats.dailyStats.slice(0, 7).map((day) => (
                <div
                  key={day.date}
                  className="flex items-center justify-between p-2 rounded hover:bg-muted text-sm"
                >
                  <span className="text-muted-foreground">
                    {new Date(day.date).toLocaleDateString('ru-RU', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                  <div className="flex items-center gap-4">
                    <span className="text-muted-foreground">{day.clicks} кликов</span>
                    <span className="text-muted-foreground">{day.conversions} продаж</span>
                    <span className="font-medium text-green-600 w-16 text-right">
                      {formatCurrency(day.earnings)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default PartnerConversionStats;
