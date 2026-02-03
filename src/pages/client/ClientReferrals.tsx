import { useEffect, useState } from 'react';
import { Users, Copy, Check, Gift, History, Trophy, BookOpen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ReferralStats } from '@/components/client';
import { useClientReferrals, useClientStore, useReferralDetails } from '@/stores/client.store';
import { useAuth } from '@/stores/auth.store';
import { TelegramMainButton } from '@/components/telegram';
import { useTelegram } from '@/hooks/useTelegram';
import {
  ReferralTree,
  ReferralLevelCard,
  ReferralHistoryTable,
  ReferralRulesDisplay,
  PointsExchangeForm,
  TopReferrersList,
} from '@/components/referrals';

/**
 * ClientReferrals page component
 * Displays detailed referral program with tabs
 */
export default function ClientReferrals(): React.ReactElement {
  const { user } = useAuth();
  const { referrals, referralStats, isLoading } = useClientReferrals();
  const {
    fullInfo,
    rules,
    history,
    levels,
    topReferrers,
    isLoadingInfo,
    isLoadingHistory,
    isExchangingPoints,
  } = useReferralDetails();

  const fetchFullReferralInfo = useClientStore((state) => state.fetchFullReferralInfo);
  const fetchReferralRules = useClientStore((state) => state.fetchReferralRules);
  const fetchReferralHistory = useClientStore((state) => state.fetchReferralHistory);
  const fetchReferralLevels = useClientStore((state) => state.fetchReferralLevels);
  const fetchTopReferrers = useClientStore((state) => state.fetchTopReferrers);
  const exchangePoints = useClientStore((state) => state.exchangePoints);

  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState('referrals');
  const { hapticFeedback, isInTelegram } = useTelegram();

  // Fetch data on mount
  useEffect(() => {
    fetchFullReferralInfo();
    fetchReferralRules();
    fetchReferralHistory();
    fetchReferralLevels();
    fetchTopReferrers();
  }, [fetchFullReferralInfo, fetchReferralRules, fetchReferralHistory, fetchReferralLevels, fetchTopReferrers]);

  // Generate referral link
  const referralLink = user?.id
    ? `${window.location.origin}/register?ref=${user.id}`
    : '';

  const handleCopyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      hapticFeedback?.('success');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleExchangePoints = async (type: string, amount: number): Promise<void> => {
    hapticFeedback?.('medium');
    await exchangePoints(type, amount);
    hapticFeedback?.('success');
  };

  const handleTabChange = (value: string): void => {
    setActiveTab(value);
    hapticFeedback?.('light');
  };

  // Transform referrals for tree view (POINTS based, not money)
  const treeData = referrals.map((ref) => ({
    id: ref.id,
    userId: ref.referredId,
    username: ref.referredUsername,
    firstName: ref.referredFirstName,
    level: 1,
    points: ref.referrerReward || 0,
    earnings: ref.referrerReward || 0,
    status: ref.status as 'active' | 'completed' | 'cancelled',
    joinedAt: ref.createdAt,
  }));

  // Get available points from stats
  const availablePoints = fullInfo?.stats?.confirmedEarnings || referralStats?.totalRewardsPaid || 0;

  // Transform levels for component
  const transformedLevels = levels.map((level) => ({
    ...level,
    totalPoints: level.totalEarnings,
    pointsPerReferral: level.commissionRate,
  }));

  // Transform history for component
  const transformedHistory = history.map((item) => ({
    ...item,
    points: item.amount,
    source: (item.description as 'bonus' | 'subscription' | 'registration' | 'purchase') || 'purchase',
  }));

  // Transform top referrers for component
  const transformedTopReferrers = topReferrers.map((referrer) => ({
    ...referrer,
    totalPoints: referrer.totalRewards,
  }));

  return (
    <div className="space-y-6">
      {/* Telegram Main Button */}
      {isInTelegram && (
        <TelegramMainButton
          text="Пригласить друга"
          onClick={handleCopyLink}
          isVisible={activeTab === 'referrals'}
        />
      )}

      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Реферальная программа</h1>
        <p className="text-muted-foreground mt-1">
          Приглашайте друзей и получайте вознаграждения
        </p>
      </div>

      {/* Stats */}
      <ReferralStats stats={referralStats} isLoading={isLoading} />

      {/* Referral Link Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Ваша реферальная ссылка
          </CardTitle>
          <CardDescription>
            Поделитесь этой ссылкой с друзьями
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={referralLink}
              readOnly
              className="flex-1"
            />
            <Button
              variant="outline"
              onClick={handleCopyLink}
              className="min-w-[100px]"
            >
              {copied ? (
                <>
                  <Check className="mr-2 h-4 w-4" />
                  Скопировано
                </>
              ) : (
                <>
                  <Copy className="mr-2 h-4 w-4" />
                  Копировать
                </>
              )}
            </Button>
          </div>
          <Alert>
            <Gift className="h-4 w-4" />
            <AlertTitle>Как это работает?</AlertTitle>
            <AlertDescription>
              1. Поделитесь ссылкой с друзьями<br />
              2. Друг регистрируется по вашей ссылке<br />
              3. Вы получаете бонус за каждого приведенного пользователя
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
        <TabsList className="grid w-full grid-cols-4 lg:w-fit">
          <TabsTrigger value="referrals" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">Мои рефералы</span>
            <span className="sm:hidden">Рефералы</span>
          </TabsTrigger>
          <TabsTrigger value="history" className="flex items-center gap-2">
            <History className="h-4 w-4" />
            <span className="hidden sm:inline">История</span>
          </TabsTrigger>
          <TabsTrigger value="rules" className="flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            <span className="hidden sm:inline">Правила</span>
          </TabsTrigger>
          <TabsTrigger value="top" className="flex items-center gap-2">
            <Trophy className="h-4 w-4" />
            <span className="hidden sm:inline">Топ</span>
          </TabsTrigger>
        </TabsList>

        {/* My Referrals Tab */}
        <TabsContent value="referrals" className="space-y-6">
          {isLoadingInfo ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Level Cards */}
              {transformedLevels.length > 0 && (
                <div className="grid gap-4 md:grid-cols-3">
                  {transformedLevels.map((level) => (
                    <ReferralLevelCard key={level.level} levelData={level} />
                  ))}
                </div>
              )}

              {/* Referral Tree */}
              <ReferralTree referrals={treeData} />

              {/* Points Exchange */}
              <PointsExchangeForm
                availablePoints={availablePoints}
                onExchange={handleExchangePoints}
                isLoading={isExchangingPoints}
              />
            </>
          )}
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history">
          <ReferralHistoryTable
            history={transformedHistory}
            isLoading={isLoadingHistory}
          />
        </TabsContent>

        {/* Rules Tab */}
        <TabsContent value="rules">
          <ReferralRulesDisplay rules={rules} />
        </TabsContent>

        {/* Top Tab */}
        <TabsContent value="top">
          <TopReferrersList
            topReferrers={transformedTopReferrers}
            currentUserId={user?.id}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
