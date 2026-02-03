import { useEffect } from 'react';
import { Link } from 'react-router';
import {
  CreditCard,
  Package,
  Users,
  Wallet,
  RefreshCw,
  ShoppingCart,
  UserPlus,
  ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useClientDashboard, useClientStore } from '@/stores/client.store';
import { useAuth } from '@/stores/auth.store';

/**
 * Format date to readable string
 */
function formatDate(dateString: string | undefined): string {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
  });
}

/**
 * Calculate days left until expiration
 */
function getDaysLeft(endDate: string | undefined): number {
  if (!endDate) return 0;
  const end = new Date(endDate);
  const now = new Date();
  const diffTime = end.getTime() - now.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * ClientDashboard page component
 * Main dashboard for client users
 */
export default function ClientDashboard(): React.ReactElement {
  const { user } = useAuth();
  const { stats, subscriptions } = useClientDashboard();
  const fetchUserProfile = useClientStore((state) => state.fetchUserProfile);
  const fetchUserStats = useClientStore((state) => state.fetchUserStats);
  const fetchSubscriptions = useClientStore((state) => state.fetchSubscriptions);

  // Fetch data on mount
  useEffect(() => {
    fetchUserProfile();
    fetchUserStats();
    fetchSubscriptions();
  }, [fetchUserProfile, fetchUserStats, fetchSubscriptions]);

  // Get active subscription
  const activeSubscription = subscriptions.find((s) => s.status === 'active');
  const daysLeft = activeSubscription ? getDaysLeft(activeSubscription.endDate) : 0;

  // Quick stats from API data
  const activeSubscriptions = parseInt(stats?.subscriptions?.active_count || '0');
  const expiringSoon = parseInt(stats?.subscriptions?.expiring_soon || '0');
  const referralCount = parseInt(stats?.referrals?.referral_count || '0');

  // Traffic usage (mock calculation)
  const trafficUsed = 45;
  const trafficLimit = 100;
  const trafficProgress = (trafficUsed / trafficLimit) * 100;

  const quickActions = [
    {
      label: 'Продлить',
      icon: RefreshCw,
      href: '/client/subscriptions',
      variant: 'default' as const,
      show: activeSubscription !== undefined,
    },
    {
      label: 'Купить подписку',
      icon: ShoppingCart,
      href: '/client/plans',
      variant: 'outline' as const,
      show: true,
    },
    {
      label: 'Пригласить друга',
      icon: UserPlus,
      href: '/client/referrals',
      variant: 'outline' as const,
      show: true,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Привет, {user?.firstName || user?.name || user?.username}!
          </h1>
          <p className="text-muted-foreground mt-1">
            Добро пожаловать в ваш личный кабинет
          </p>
        </div>
        <div className="flex items-center gap-2">
          {quickActions
            .filter((action) => action.show)
            .map((action) => {
              const Icon = action.icon;
              return (
                <Button key={action.label} variant={action.variant} size="sm" asChild>
                  <Link to={action.href}>
                    <Icon className="mr-2 h-4 w-4" />
                    {action.label}
                  </Link>
                </Button>
              );
            })}
        </div>
      </div>

      {/* Active Subscription Card */}
      {activeSubscription ? (
        <Card className="border-l-4 border-l-green-500">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Активная подписка</CardTitle>
                <CardDescription>
                  {activeSubscription.planName}
                </CardDescription>
              </div>
              <Badge variant={daysLeft <= 7 ? 'destructive' : 'default'}>
                {daysLeft} дней осталось
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Действует до:</span>
              <span className="font-medium">{formatDate(activeSubscription.endDate)}</span>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Использовано трафика:</span>
                <span className="font-medium">{trafficUsed} / {trafficLimit} GB</span>
              </div>
              <Progress value={trafficProgress} />
            </div>
            <Button asChild className="w-full sm:w-auto">
              <Link to="/client/subscriptions">
                Управление подпиской
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-l-4 border-l-yellow-500">
          <CardHeader>
            <CardTitle>Нет активной подписки</CardTitle>
            <CardDescription>
              Оформите подписку, чтобы начать использовать VPN
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/client/plans">
                <ShoppingCart className="mr-2 h-4 w-4" />
                Выбрать тариф
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Активные подписки</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeSubscriptions}</div>
            <p className="text-xs text-muted-foreground">
              {expiringSoon > 0 && `${expiringSoon} истекает скоро`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Рефералы</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{referralCount}</div>
            <p className="text-xs text-muted-foreground">
              <Link to="/client/referrals" className="text-primary hover:underline">
                Пригласить еще
              </Link>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Баланс</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">$0.00</div>
            <p className="text-xs text-muted-foreground">
              <Link to="/client/partner" className="text-primary hover:underline">
                Партнерская программа
              </Link>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Доступные тарифы</CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">5+</div>
            <p className="text-xs text-muted-foreground">
              <Link to="/client/plans" className="text-primary hover:underline">
                Смотреть все
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity Placeholder */}
      <Card>
        <CardHeader>
          <CardTitle>Последние действия</CardTitle>
          <CardDescription>
            История ваших последних операций
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <p>Здесь будут отображаться ваши последние операции</p>
            <Button variant="outline" className="mt-4" asChild>
              <Link to="/client/payments">
                История платежей
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
