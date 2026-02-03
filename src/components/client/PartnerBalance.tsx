import { Wallet, ArrowUpRight, TrendingUp, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { PartnerData } from '@/api/client.service';

/**
 * PartnerBalance props interface
 */
interface PartnerBalanceProps {
  partner: PartnerData | null;
  isLoading?: boolean;
  onRequestPayout: () => void;
}

/**
 * PartnerBalance component
 * Displays partner balance and stats with payout button
 */
export function PartnerBalance({ partner, isLoading, onRequestPayout }: PartnerBalanceProps): React.ReactElement {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Партнерский баланс</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="h-20 animate-pulse rounded-lg bg-muted" />
          <div className="grid grid-cols-2 gap-4">
            <div className="h-16 animate-pulse rounded-lg bg-muted" />
            <div className="h-16 animate-pulse rounded-lg bg-muted" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!partner) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Партнерский баланс</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            Вы еще не зарегистрированы в партнерской программе.
          </p>
          <Button className="w-full mt-4">
            Стать партнером
          </Button>
        </CardContent>
      </Card>
    );
  }

  const balance = partner.pendingEarnings || 0;
  const totalEarned = partner.totalEarnings || 0;
  const referralCount = partner.referralCount || 0;
  const commissionRate = partner.commissionRate || 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Wallet className="h-4 w-4" />
          Партнерский баланс
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Main Balance */}
        <div className="rounded-lg bg-primary/5 p-4">
          <p className="text-sm text-muted-foreground">Доступно для вывода</p>
          <p className="text-3xl font-bold">${balance.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Комиссия: {commissionRate}%
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-muted p-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-green-500" />
              <span className="text-xs text-muted-foreground">Всего заработано</span>
            </div>
            <p className="text-lg font-semibold mt-1">${totalEarned.toFixed(2)}</p>
          </div>
          <div className="rounded-lg bg-muted p-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-500" />
              <span className="text-xs text-muted-foreground">Рефералов</span>
            </div>
            <p className="text-lg font-semibold mt-1">{referralCount}</p>
          </div>
        </div>

        {/* Payout Button */}
        <Button
          className="w-full"
          onClick={onRequestPayout}
          disabled={balance <= 0}
        >
          <ArrowUpRight className="mr-2 h-4 w-4" />
          Запросить выплату
        </Button>
      </CardContent>
    </Card>
  );
}

export default PartnerBalance;
