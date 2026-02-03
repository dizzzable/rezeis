import { useEffect, useState } from 'react';
import { DollarSign, Users, Wallet, BarChart3, Loader2, Lock, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PartnerBalance } from '@/components/client';
import { TelegramMainButton } from '@/components/telegram';
import { useTelegram } from '@/hooks/useTelegram';
import {
  PartnerStatsCards,
  PartnerEarningsChart,
  PartnerConversionStats,
  PartnerEarningsTable,
  PartnerPayoutsTable,
  PartnerReferralTable,
} from '@/components/partner';
import { partnerClientService } from '@/api/partner-client.service';
import { useClientStore } from '@/stores/client.store';

/**
 * ClientPartner page component
 * Displays detailed partner dashboard with tabs
 * Shows locked state for non-partners
 */
export default function ClientPartner(): React.ReactElement {
  const [partnerStatus, setPartnerStatus] = useState<{
    isPartner: boolean;
    canRequest: boolean;
    activatedAt: string | null;
  } | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);

  const { partner, isLoading } = useClientStore((state) => ({
    partner: state.partner,
    isLoading: state.isLoadingPartner,
  }));
  const {
    fullStats,
    earnings,
    payouts,
    referrals,
    conversionStats,
    isLoadingStats,
    isLoadingEarnings,
    isLoadingPayouts,
    isLoadingConversion,
  } = useClientStore((state) => ({
    fullStats: state.fullPartnerStats,
    earnings: state.partnerEarnings,
    payouts: state.partnerPayouts,
    referrals: state.partnerReferrals,
    conversionStats: state.conversionStats,
    isLoadingStats: state.isLoadingPartner,
    isLoadingEarnings: state.isLoadingPartnerEarnings,
    isLoadingPayouts: state.isLoadingPartnerPayouts,
    isLoadingConversion: state.isLoadingConversionStats,
  }));

  const fetchFullPartnerStats = useClientStore((state) => state.fetchFullPartnerStats);
  const fetchPartnerEarnings = useClientStore((state) => state.fetchPartnerEarnings);
  const fetchPartnerPayouts = useClientStore((state) => state.fetchPartnerPayouts);
  const fetchPartnerReferrals = useClientStore((state) => state.fetchPartnerReferrals);
  const fetchConversionStats = useClientStore((state) => state.fetchConversionStats);
  const requestPayout = useClientStore((state) => state.requestPayout);

  const [activeTab, setActiveTab] = useState('overview');
  const [isPayoutModalOpen, setIsPayoutModalOpen] = useState(false);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutMethod, setPayoutMethod] = useState('bank_transfer');
  const [payoutRequisites, setPayoutRequisites] = useState('');
  const { isInTelegram, showConfirm } = useTelegram();

  // Check partner status on mount
  useEffect(() => {
    const checkPartnerStatus = async () => {
      try {
        const status = await partnerClientService.getPartnerStatus();
        setPartnerStatus(status);
      } catch (error) {
        console.error('Failed to get partner status:', error);
      } finally {
        setIsLoadingStatus(false);
      }
    };

    checkPartnerStatus();
  }, []);

  // Fetch data only if user is partner
  useEffect(() => {
    if (partnerStatus?.isPartner) {
      fetchFullPartnerStats();
      fetchPartnerEarnings();
      fetchPartnerPayouts();
      fetchPartnerReferrals();
      fetchConversionStats();
    }
  }, [
    partnerStatus?.isPartner,
    fetchFullPartnerStats,
    fetchPartnerEarnings,
    fetchPartnerPayouts,
    fetchPartnerReferrals,
    fetchConversionStats,
  ]);

  const handleRequestPayout = (): void => {
    setIsPayoutModalOpen(true);
  };

  const handleSubmitPayout = async (): Promise<void> => {
    const amount = parseFloat(payoutAmount);
    if (amount > 0 && payoutMethod && payoutRequisites) {
      const confirmed = await showConfirm(`Запросить выплату ${amount}$?`);
      if (confirmed) {
        await requestPayout({
          amount,
          method: payoutMethod,
          requisites: payoutRequisites,
        });
        setIsPayoutModalOpen(false);
        setPayoutAmount('');
        setPayoutRequisites('');
      }
    }
  };

  const handleTabChange = (value: string): void => {
    setActiveTab(value);
  };

  // Show loading state
  if (isLoadingStatus) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Show locked state for non-partners
  if (!partnerStatus?.isPartner) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4">
        <div className="bg-muted rounded-full p-6 mb-6">
          <Lock className="h-16 w-16 text-muted-foreground" />
        </div>
        <h2 className="text-2xl font-bold mb-2 text-center">Партнерская программа</h2>
        <p className="text-muted-foreground text-center max-w-md mb-6">
          Партнерская программа доступна только по приглашению администратора.
          Обратитесь к поддержке для получения доступа.
        </p>
        <div className="space-y-3 w-full max-w-sm">
          <Button 
            className="w-full" 
            onClick={() => window.open('https://t.me/support', '_blank')}
          >
            <MessageCircle className="mr-2 h-4 w-4" />
            Написать в поддержку
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            После активации администратором вы получите доступ к партнерскому кабинету
          </p>
        </div>

        {/* Show partner benefits info */}
        <Card className="mt-8 w-full max-w-lg">
          <CardHeader>
            <CardTitle className="text-lg">Преимущества партнерской программы</CardTitle>
            <CardDescription>
              Что вы получите, став партнером
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <div className="text-center p-4 bg-muted rounded-lg">
              <DollarSign className="h-8 w-8 mx-auto mb-2 text-green-500" />
              <p className="font-medium text-sm">До 10% комиссии</p>
              <p className="text-xs text-muted-foreground">с каждого платежа рефералов</p>
            </div>
            <div className="text-center p-4 bg-muted rounded-lg">
              <Users className="h-8 w-8 mx-auto mb-2 text-blue-500" />
              <p className="font-medium text-sm">3 уровня рефералов</p>
              <p className="text-xs text-muted-foreground">зарабатывайте с их покупок</p>
            </div>
            <div className="text-center p-4 bg-muted rounded-lg">
              <Wallet className="h-8 w-8 mx-auto mb-2 text-purple-500" />
              <p className="font-medium text-sm">Быстрые выплаты</p>
              <p className="text-xs text-muted-foreground">удобным способом</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Default stats for loading state
  const defaultStats = {
    partner: {
      balance: 0,
      totalEarnings: 0,
      paidEarnings: 0,
      pendingEarnings: 0,
      referralCount: 0,
      commissionRate: 10,
    },
    thirtyDaysStats: {
      totalClicks: 0,
      totalConversions: 0,
      totalEarnings: 0,
      conversionRate: 0,
    },
    currentLevel: null,
    nextLevel: null,
  };

  const stats = fullStats || defaultStats;

  // Transform earnings for component
  const transformedEarnings = earnings.map((item) => ({
    ...item,
    status: item.status as 'pending' | 'approved' | 'paid' | 'cancelled',
  }));

  // Transform payouts for component
  const transformedPayouts = payouts.map((item) => ({
    ...item,
    status: item.status as 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled',
  }));

  // Transform referrals for component
  const transformedReferrals = referrals.map((item) => ({
    ...item,
    status: item.status as 'active' | 'inactive' | 'converted',
  }));

  return (
    <div className="space-y-6">
      {/* Telegram Main Button */}
      {isInTelegram && (
        <TelegramMainButton
          text="Запросить выплату"
          onClick={handleRequestPayout}
          isVisible={activeTab === 'overview' && (partner?.pendingPayouts || 0) > 0}
        />
      )}

      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">Партнерский кабинет</h1>
            <span className="bg-green-100 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded dark:bg-green-900 dark:text-green-300">
              Активен
            </span>
          </div>
          <p className="text-muted-foreground mt-1">
            Управление партнерской программой
          </p>
        </div>
      </div>

      {/* Partner Balance Card */}
      <PartnerBalance
        partner={partner}
        isLoading={isLoading}
        onRequestPayout={handleRequestPayout}
      />

      {/* Payout Request Modal */}
      {isPayoutModalOpen && (
        <Card>
          <CardHeader>
            <CardTitle>Запрос выплаты</CardTitle>
            <CardDescription>
              Укажите сумму и реквизиты для вывода средств
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="amount">Сумма ($)</Label>
              <Input
                id="amount"
                type="number"
                placeholder="Введите сумму"
                value={payoutAmount}
                onChange={(e) => setPayoutAmount(e.target.value)}
                max={partner?.pendingPayouts || 0}
              />
              <p className="text-xs text-muted-foreground">
                Доступно: ${partner?.pendingPayouts?.toFixed(2) || '0.00'}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="method">Способ выплаты</Label>
              <select
                id="method"
                value={payoutMethod}
                onChange={(e) => setPayoutMethod(e.target.value)}
                className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="bank_transfer">Банковский перевод</option>
                <option value="paypal">PayPal</option>
                <option value="crypto">Криптовалюта</option>
                <option value="other">Другое</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="requisites">Реквизиты</Label>
              <Input
                id="requisites"
                placeholder="Введите реквизиты"
                value={payoutRequisites}
                onChange={(e) => setPayoutRequisites(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={handleSubmitPayout}
                disabled={!payoutAmount || !payoutMethod || !payoutRequisites}
              >
                Запросить
              </Button>
              <Button variant="outline" onClick={() => setIsPayoutModalOpen(false)}>
                Отмена
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
        <TabsList className="grid w-full grid-cols-4 lg:w-fit">
          <TabsTrigger value="overview" className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            <span className="hidden sm:inline">Обзор</span>
          </TabsTrigger>
          <TabsTrigger value="earnings" className="flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            <span className="hidden sm:inline">Начисления</span>
          </TabsTrigger>
          <TabsTrigger value="payouts" className="flex items-center gap-2">
            <Wallet className="h-4 w-4" />
            <span className="hidden sm:inline">Выплаты</span>
          </TabsTrigger>
          <TabsTrigger value="referrals" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">Рефералы</span>
          </TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6">
          {isLoadingStats ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <PartnerStatsCards stats={stats} isLoading={false} />
              
              <div className="grid gap-6 lg:grid-cols-2">
                <PartnerEarningsChart
                  dailyStats={conversionStats?.dailyStats || []}
                  periodDays={conversionStats?.periodDays || 30}
                  isLoading={isLoadingConversion}
                />
                <PartnerConversionStats
                  stats={
                    conversionStats || {
                      totalClicks: 0,
                      totalUniqueClicks: 0,
                      totalConversions: 0,
                      totalEarnings: 0,
                      conversionRate: 0,
                      dailyStats: [],
                      periodDays: 30,
                    }
                  }
                  isLoading={isLoadingConversion}
                />
              </div>
            </>
          )}
        </TabsContent>

        {/* Earnings Tab */}
        <TabsContent value="earnings">
          <PartnerEarningsTable earnings={transformedEarnings} isLoading={isLoadingEarnings} />
        </TabsContent>

        {/* Payouts Tab */}
        <TabsContent value="payouts">
          <PartnerPayoutsTable payouts={transformedPayouts} isLoading={isLoadingPayouts} />
        </TabsContent>

        {/* Referrals Tab */}
        <TabsContent value="referrals">
          <PartnerReferralTable referrals={transformedReferrals} isLoading={isLoading} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
