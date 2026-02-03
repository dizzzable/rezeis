/**
 * MiniAppHome Page
 * Compact dashboard optimized for Telegram Mini App
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MiniAppLayout } from '@/components/telegram/MiniAppLayout';
import { TelegramMainButton } from '@/components/telegram/TelegramMainButton';
import { PullToRefresh } from '@/components/telegram/PullToRefresh';
import { useTelegram } from '@/hooks/useTelegram';
import { useAuth } from '@/stores/auth.store';
import { clientService } from '@/api/client.service';
import type { UserSubscription } from '@/api/client.service';
import {
  Shield,
  CreditCard,
  Users,
  Gift,
  ChevronRight,
  Clock,
  AlertCircle,
  Server,
} from 'lucide-react';

/**
 * Quick action card component
 */
function QuickActionCard({
  icon: Icon,
  title,
  description,
  onClick,
  badge,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  onClick: () => void;
  badge?: string;
}): React.ReactElement {
  const { hapticFeedback } = useTelegram();

  const handleClick = (): void => {
    hapticFeedback('light');
    onClick();
  };

  return (
    <Card
      className="cursor-pointer hover:bg-accent/50 transition-colors"
      onClick={handleClick}
    >
      <CardContent className="p-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Icon className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm truncate">{title}</h3>
            {badge && (
              <Badge variant="secondary" className="text-xs px-1.5 py-0">
                {badge}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">{description}</p>
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      </CardContent>
    </Card>
  );
}

/**
 * Subscription status card component
 */
function SubscriptionStatusCard({
  hasActiveSubscription,
  expiryDate,
  onExtend,
}: {
  hasActiveSubscription: boolean;
  expiryDate?: string;
  onExtend: () => void;
}): React.ReactElement {
  const { hapticFeedback } = useTelegram();

  const handleExtend = (): void => {
    hapticFeedback('medium');
    onExtend();
  };

  if (!hasActiveSubscription) {
    return (
      <Card className="border-destructive/50 bg-destructive/5">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="font-medium text-sm">Нет активной подписки</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Оформите подписку для доступа к VPN
              </p>
              <Button
                size="sm"
                className="mt-3 w-full"
                onClick={handleExtend}
              >
                Оформить подписку
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-green-500/50 bg-green-500/5">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Shield className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-medium text-sm">Подписка активна</h3>
            <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              <span>Действует до: {expiryDate}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 w-full"
              onClick={handleExtend}
            >
              Продлить
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Mini App Home page
 */
export function MiniAppHome(): React.ReactElement {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { hapticFeedback, isInTelegram } = useTelegram();

  // Fetch user stats
  const { data: stats, refetch: refetchStats } = useQuery({
    queryKey: ['client-stats'],
    queryFn: () => clientService.getUserStats(),
  });

  // Fetch subscriptions
  const { data: subscriptions, refetch: refetchSubscriptions } = useQuery({
    queryKey: ['client-subscriptions'],
    queryFn: () => clientService.getUserSubscriptions(),
  });

  // Fetch referrals stats
  const { data: referralsStats, refetch: refetchReferrals } = useQuery({
    queryKey: ['client-referral-stats'],
    queryFn: () => clientService.getReferralStats(),
  });

  // Check if user has active subscription
  const activeSubscription = subscriptions?.find((sub: UserSubscription) => sub.status === 'active');
  const hasActiveSubscription = !!activeSubscription;

  // Handle refresh
  const handleRefresh = async (): Promise<void> => {
    await Promise.all([
      refetchStats(),
      refetchSubscriptions(),
      refetchReferrals(),
    ]);
  };

  // Navigation handlers
  const handleNavigateToPlans = (): void => {
    hapticFeedback('light');
    navigate('/client/plans');
  };

  const handleNavigateToSubscriptions = (): void => {
    hapticFeedback('light');
    navigate('/client/subscriptions');
  };

  const handleNavigateToReferrals = (): void => {
    hapticFeedback('light');
    navigate('/client/referrals');
  };

  const handleNavigateToPartner = (): void => {
    hapticFeedback('light');
    navigate('/client/partner');
  };

  const handleNavigateToServers = (): void => {
    hapticFeedback('light');
    navigate('/miniapp/servers');
  };

  // Set Telegram Main Button
  useEffect(() => {
    if (!isInTelegram) return;

    // Show buy button if no active subscription
    if (!hasActiveSubscription) {
      // MainButton is handled by TelegramMainButton component
    }
  }, [hasActiveSubscription, isInTelegram]);

  const userName = user?.username || user?.firstName || 'Пользователь';

  return (
    <MiniAppLayout title="AltShop VPN" contentClassName="pb-20">
      <PullToRefresh onRefresh={handleRefresh} className="h-full">
        <div className="p-4 space-y-4">
          {/* Welcome header */}
          <div className="text-center py-4">
            <h1 className="text-xl font-bold">Привет, {userName}!</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Управляйте вашей VPN подпиской
            </p>
          </div>

          {/* Subscription status */}
          <SubscriptionStatusCard
            hasActiveSubscription={hasActiveSubscription}
            expiryDate={activeSubscription?.endDate}
            onExtend={handleNavigateToPlans}
          />

          {/* Quick actions */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Быстрые действия
            </h2>

            <QuickActionCard
              icon={Server}
              title="Серверы"
              description="Выберите лучший сервер"
              onClick={handleNavigateToServers}
            />

            <QuickActionCard
              icon={Shield}
              title="Мои подписки"
              description={hasActiveSubscription ? 'Просмотр и управление' : 'Оформить подписку'}
              onClick={handleNavigateToSubscriptions}
              badge={hasActiveSubscription ? '1' : undefined}
            />

            <QuickActionCard
              icon={CreditCard}
              title="Тарифы"
              description="Выберите подходящий план"
              onClick={handleNavigateToPlans}
            />

            <QuickActionCard
              icon={Users}
              title="Рефералы"
              description={`${referralsStats?.totalReferrals || 0} приглашенных`}
              onClick={handleNavigateToReferrals}
            />

            {user?.role === 'admin' && (
              <QuickActionCard
                icon={Gift}
                title="Партнерская программа"
                description={`${referralsStats?.totalRewardsPaid || 0} на балансе`}
                onClick={handleNavigateToPartner}
              />
            )}
          </div>

          {/* Stats overview */}
          {stats && (
            <div className="grid grid-cols-2 gap-3 pt-2">
              <Card>
                <CardHeader className="p-3 pb-2">
                  <CardTitle className="text-xs text-muted-foreground font-normal">
                    Подписки
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-2xl font-bold">
                    {stats.subscriptions?.active_subscriptions || 0}
                  </p>
                  <p className="text-xs text-muted-foreground">активных</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-3 pb-2">
                  <CardTitle className="text-xs text-muted-foreground font-normal">
                    Рефералы
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-2xl font-bold">
                    {referralsStats?.totalReferrals || 0}
                  </p>
                  <p className="text-xs text-muted-foreground">приглашено</p>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </PullToRefresh>

      {/* Telegram Main Button for purchasing */}
      {!hasActiveSubscription && (
        <TelegramMainButton
          text="Оформить подписку"
          onClick={handleNavigateToPlans}
          isVisible={true}
        />
      )}
    </MiniAppLayout>
  );
}

export default MiniAppHome;
