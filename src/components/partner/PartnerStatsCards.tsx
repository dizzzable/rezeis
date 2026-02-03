import { DollarSign, TrendingUp, Users, MousePointer, Target, Percent } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

interface PartnerStats {
  partner: {
    balance: number;
    totalEarnings: number;
    paidEarnings: number;
    pendingEarnings: number;
    referralCount: number;
    commissionRate: number;
  };
  thirtyDaysStats: {
    totalClicks: number;
    totalConversions: number;
    totalEarnings: number;
    conversionRate: number;
  };
  currentLevel: {
    name: string;
    commissionRate: number;
    minReferrals: number;
    minEarnings: number;
  } | null;
  nextLevel: {
    name: string;
    minReferrals: number;
    minEarnings: number;
  } | null;
}

interface PartnerStatsCardsProps {
  stats: PartnerStats;
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
 * Stat card component
 */
function StatCard({
  title,
  value,
  icon,
  trend,
  trendLabel,
  className,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  trend?: string;
  trendLabel?: string;
  className?: string;
}): React.ReactElement {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center text-muted-foreground">
          {icon}
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {trend && (
          <p className="text-xs text-muted-foreground mt-1">
            <span className="text-green-600 font-medium">{trend}</span>
            {trendLabel && ` ${trendLabel}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * PartnerStatsCards component
 * Displays partner statistics in a grid of cards
 */
export function PartnerStatsCards({ stats, isLoading, className }: PartnerStatsCardsProps): React.ReactElement {
  if (isLoading) {
    return (
      <div className={cn('grid gap-4 md:grid-cols-2 lg:grid-cols-4', className)}>
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="h-[120px] animate-pulse bg-muted" />
        ))}
      </div>
    );
  }

  const { partner, thirtyDaysStats, currentLevel, nextLevel } = stats;

  // Calculate progress to next level
  const referralsProgress = nextLevel
    ? Math.min(100, (partner.referralCount / nextLevel.minReferrals) * 100)
    : 100;
  const earningsProgress = nextLevel
    ? Math.min(100, (partner.totalEarnings / nextLevel.minEarnings) * 100)
    : 100;

  return (
    <div className={cn('space-y-4', className)}>
      {/* Main Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Баланс"
          value={formatCurrency(partner.balance)}
          icon={<DollarSign className="h-4 w-4" />}
          trend="Доступно для вывода"
          className="border-green-200"
        />
        <StatCard
          title="Всего заработано"
          value={formatCurrency(partner.totalEarnings)}
          icon={<TrendingUp className="h-4 w-4" />}
          trend={`${partner.referralCount} рефералов`}
          className="border-blue-200"
        />
        <StatCard
          title="Конверсия (30 дней)"
          value={`${thirtyDaysStats.conversionRate.toFixed(1)}%`}
          icon={<Target className="h-4 w-4" />}
          trend={`${thirtyDaysStats.totalConversions} из ${thirtyDaysStats.totalClicks}`}
          className="border-purple-200"
        />
        <StatCard
          title="Уровень"
          value={currentLevel?.name || 'Новичок'}
          icon={<Percent className="h-4 w-4" />}
          trend={`${currentLevel?.commissionRate || 10}% комиссия`}
          className="border-amber-200"
        />
      </div>

      {/* Clicks & Conversions */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Переходы за 30 дней</CardTitle>
            <MousePointer className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{thirtyDaysStats.totalClicks}</div>
            <p className="text-xs text-muted-foreground mt-1">
              По вашей реферальной ссылке
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Рефералы</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{partner.referralCount}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Всего привлечено пользователей
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Level Progress */}
      {nextLevel && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Прогресс к уровню "{nextLevel.name}"</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Рефералы</span>
                <span className="font-medium">
                  {partner.referralCount} / {nextLevel.minReferrals}
                </span>
              </div>
              <Progress value={referralsProgress} className="h-2" />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Заработок</span>
                <span className="font-medium">
                  {formatCurrency(partner.totalEarnings)} / {formatCurrency(nextLevel.minEarnings)}
                </span>
              </div>
              <Progress value={earningsProgress} className="h-2" />
            </div>
            <p className="text-sm text-muted-foreground">
              Выполните условия, чтобы перейти на следующий уровень и получить повышенную комиссию.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default PartnerStatsCards;
