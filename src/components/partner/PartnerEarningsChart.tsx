import { useMemo } from 'react';
import { TrendingUp, Calendar } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DailyStat {
  date: string;
  earnings: number;
  conversions: number;
  clicks: number;
}

interface PartnerEarningsChartProps {
  dailyStats: DailyStat[];
  periodDays: number;
  isLoading: boolean;
  className?: string;
}

/**
 * Format date
 */
function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Format currency
 */
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  }).format(amount);
}

/**
 * PartnerEarningsChart component
 * Displays earnings chart using simple bar visualization
 */
export function PartnerEarningsChart({
  dailyStats,
  periodDays,
  isLoading,
  className,
}: PartnerEarningsChartProps): React.ReactElement {
  const chartData = useMemo(() => {
    // Sort by date and take last 14 days for display
    return [...dailyStats]
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .slice(-14);
  }, [dailyStats]);

  const maxEarnings = useMemo(() => {
    if (chartData.length === 0) return 1;
    return Math.max(...chartData.map((d) => d.earnings), 1);
  }, [chartData]);

  const totalEarnings = useMemo(() => {
    return chartData.reduce((sum, d) => sum + d.earnings, 0);
  }, [chartData]);

  if (isLoading) {
    return (
      <Card className={cn('h-[300px]', className)}>
        <CardContent className="flex items-center justify-center h-full">
          <div className="animate-pulse bg-muted h-[200px] w-full rounded" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-lg">
            <TrendingUp className="h-5 w-5" />
            График доходов
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            {formatCurrency(totalEarnings)} за {periodDays} дней
          </p>
        </div>
        <Button variant="outline" size="sm">
          <Calendar className="h-4 w-4 mr-1" />
          {periodDays} дней
        </Button>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="h-[200px] flex items-center justify-center text-muted-foreground">
            Нет данных за выбранный период
          </div>
        ) : (
          <div className="space-y-4">
            {/* Simple Bar Chart */}
            <div className="h-[200px] flex items-end gap-1">
              {chartData.map((day, index) => {
                const height = maxEarnings > 0 ? (day.earnings / maxEarnings) * 100 : 0;
                return (
                  <div
                    key={day.date}
                    className="flex-1 flex flex-col items-center gap-1 group"
                  >
                    <div className="relative w-full flex items-end justify-center">
                      <div
                        className={cn(
                          'w-full max-w-[24px] rounded-t transition-all duration-300',
                          height > 0 ? 'bg-primary' : 'bg-muted',
                          'group-hover:bg-primary/80'
                        )}
                        style={{ height: `${Math.max(height, 4)}%` }}
                      />
                      {/* Tooltip */}
                      <div className="absolute bottom-full mb-2 opacity-0 group-hover:opacity-100 transition-opacity bg-popover text-popover-foreground text-xs rounded px-2 py-1 whitespace-nowrap z-10 pointer-events-none">
                        {formatCurrency(day.earnings)}
                      </div>
                    </div>
                    <span className="text-[10px] text-muted-foreground rotate-0">
                      {index % 2 === 0 ? formatDate(day.date) : ''}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Legend */}
            <div className="flex items-center justify-center gap-4 text-sm">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded bg-primary" />
                <span className="text-muted-foreground">Доход</span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default PartnerEarningsChart;
