import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Plus, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SubscriptionCard, QRCodeModal } from '@/components/client';
import { useClientSubscriptions, useClientStore } from '@/stores/client.store';
import type { UserSubscription } from '@/api/client.service';

/**
 * ClientSubscriptions page component
 * Displays user's subscriptions with management options
 */
export default function ClientSubscriptions(): React.ReactElement {
  const { subscriptions, isLoading } = useClientSubscriptions();
  const fetchSubscriptions = useClientStore((state) => state.fetchSubscriptions);
  const renewSubscription = useClientStore((state) => state.renewSubscription);
  const getSubscriptionQR = useClientStore((state) => state.getSubscriptionQR);

  const [selectedSubscription, setSelectedSubscription] = useState<UserSubscription | null>(null);
  const [qrData, setQrData] = useState<string>('');
  const [isQRModalOpen, setIsQRModalOpen] = useState(false);

  // Fetch subscriptions on mount
  useEffect(() => {
    fetchSubscriptions();
  }, [fetchSubscriptions]);

  // Filter subscriptions
  const activeSubscriptions = subscriptions.filter((s) => s.status === 'active');
  const expiredSubscriptions = subscriptions.filter((s) => s.status === 'expired');

  const handleShowQR = async (subscription: UserSubscription): Promise<void> => {
    const result = await getSubscriptionQR(parseInt(subscription.id));
    if (result) {
      setSelectedSubscription(subscription);
      setQrData(result.qrData);
      setIsQRModalOpen(true);
    }
  };

  const handleRenew = async (subscription: UserSubscription): Promise<void> => {
    await renewSubscription(parseInt(subscription.id));
  };

  const handleCloseQR = (): void => {
    setIsQRModalOpen(false);
    setSelectedSubscription(null);
    setQrData('');
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Мои подписки</h1>
          <p className="text-muted-foreground mt-1">
            Управление вашими VPN подписками
          </p>
        </div>
        <Button asChild>
          <Link to="/client/plans">
            <Plus className="mr-2 h-4 w-4" />
            Новая подписка
          </Link>
        </Button>
      </div>

      {/* No Subscriptions Alert */}
      {subscriptions.length === 0 && !isLoading && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Нет подписок</AlertTitle>
          <AlertDescription>
            У вас пока нет активных подписок. Оформите подписку, чтобы начать использовать VPN.
            <div className="mt-4">
              <Button asChild size="sm">
                <Link to="/client/plans">Выбрать тариф</Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Subscriptions Tabs */}
      {subscriptions.length > 0 && (
        <Tabs defaultValue="active" className="w-full">
          <TabsList>
            <TabsTrigger value="active">
              Активные ({activeSubscriptions.length})
            </TabsTrigger>
            <TabsTrigger value="expired">
              Истекшие ({expiredSubscriptions.length})
            </TabsTrigger>
            <TabsTrigger value="all">
              Все ({subscriptions.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="mt-6">
            {activeSubscriptions.length === 0 ? (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Нет активных подписок</AlertTitle>
                <AlertDescription>
                  У вас нет активных подписок. Оформите новую подписку.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {activeSubscriptions.map((subscription) => (
                  <SubscriptionCard
                    key={subscription.id}
                    subscription={subscription}
                    onShowQR={handleShowQR}
                    onRenew={handleRenew}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="expired" className="mt-6">
            {expiredSubscriptions.length === 0 ? (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Нет истекших подписок</AlertTitle>
                <AlertDescription>
                  У вас нет истекших подписок.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {expiredSubscriptions.map((subscription) => (
                  <SubscriptionCard
                    key={subscription.id}
                    subscription={subscription}
                    onShowQR={handleShowQR}
                    onRenew={handleRenew}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="all" className="mt-6">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {subscriptions.map((subscription) => (
                <SubscriptionCard
                  key={subscription.id}
                  subscription={subscription}
                  onShowQR={handleShowQR}
                  onRenew={handleRenew}
                />
              ))}
            </div>
          </TabsContent>
        </Tabs>
      )}

      {/* QR Code Modal */}
      <QRCodeModal
        isOpen={isQRModalOpen}
        onClose={handleCloseQR}
        subscription={selectedSubscription}
        qrData={qrData}
      />
    </div>
  );
}
