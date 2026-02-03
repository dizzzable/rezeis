import { Users, Gift, DollarSign, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ReferralStatistics } from '@/types/entity.types';

/**
 * ReferralStats props interface
 */
interface ReferralStatsProps {
  stats: ReferralStatistics | null;
  isLoading?: boolean;
}

/**
 * Stat item component
 */
function StatItem({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  color: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3">
      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${color}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold">{value}</p>
      </div>
    </div>
  );
}

/**
 * ReferralStats component
 * Displays referral statistics in a grid
 */
export function ReferralStats({ stats, isLoading }: ReferralStatsProps): React.ReactElement {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Статистика рефералов</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const safeStats = stats || {
    totalReferrals: 0,
    activeReferrals: 0,
    completedReferrals: 0,
    totalRewardsPaid: 0,
    pendingRewards: 0,
    topReferrers: [],
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Статистика рефералов</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <StatItem
            icon={Users}
            label="Всего рефералов"
            value={safeStats.totalReferrals}
            color="bg-blue-500/10 text-blue-500"
          />
          <StatItem
            icon={TrendingUp}
            label="Активных"
            value={safeStats.activeReferrals}
            color="bg-green-500/10 text-green-500"
          />
          <StatItem
            icon={DollarSign}
            label="Заработано"
            value={`$${safeStats.totalRewardsPaid}`}
            color="bg-yellow-500/10 text-yellow-500"
          />
          <StatItem
            icon={Gift}
            label="Ожидает выплаты"
            value={`$${safeStats.pendingRewards}`}
            color="bg-purple-500/10 text-purple-500"
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default ReferralStats;
