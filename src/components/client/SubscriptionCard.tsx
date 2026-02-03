import { Calendar, QrCode, RefreshCw, Wifi } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import type { UserSubscription } from '@/api/client.service';

/**
 * SubscriptionCard props interface
 */
interface SubscriptionCardProps {
  subscription: UserSubscription;
  onShowQR: (subscription: UserSubscription) => void;
  onRenew: (subscription: UserSubscription) => void;
}

/**
 * Format date to readable string
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Calculate days left until expiration
 */
function getDaysLeft(endDate: string): number {
  const end = new Date(endDate);
  const now = new Date();
  const diffTime = end.getTime() - now.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Get status badge variant
 */
function getStatusBadge(status: string): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  switch (status) {
    case 'active':
      return { label: 'Активна', variant: 'default' };
    case 'expired':
      return { label: 'Истекла', variant: 'destructive' };
    case 'cancelled':
      return { label: 'Отменена', variant: 'secondary' };
    case 'pending':
      return { label: 'Ожидает', variant: 'outline' };
    default:
      return { label: status, variant: 'secondary' };
  }
}

/**
 * SubscriptionCard component
 * Displays a subscription with progress and actions
 */
export function SubscriptionCard({ subscription, onShowQR, onRenew }: SubscriptionCardProps): React.ReactElement {
  const daysLeft = getDaysLeft(subscription.endDate);
  const statusBadge = getStatusBadge(subscription.status);
  const isActive = subscription.status === 'active';

  // Calculate traffic progress (mock data - would come from API)
  const trafficUsed = 45; // GB
  const trafficLimit = subscription.trafficLimit || 100; // GB
  const trafficProgress = Math.min((trafficUsed / trafficLimit) * 100, 100);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Wifi className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">{subscription.planName}</CardTitle>
              <p className="text-xs text-muted-foreground">
                ID: {subscription.id}
              </p>
            </div>
          </div>
          <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Days Left */}
        <div className="flex items-center gap-2 text-sm">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">До окончания:</span>
          <span className={cn(
            'font-medium',
            daysLeft <= 3 ? 'text-destructive' : daysLeft <= 7 ? 'text-yellow-500' : 'text-green-500'
          )}>
            {daysLeft > 0 ? `${daysLeft} дней` : 'Истекла'}
          </span>
        </div>

        {/* End Date */}
        <div className="text-sm text-muted-foreground">
          Действует до: <span className="text-foreground">{formatDate(subscription.endDate)}</span>
        </div>

        {/* Traffic Usage */}
        {isActive && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Использовано трафика:</span>
              <span className="font-medium">{trafficUsed} / {trafficLimit} GB</span>
            </div>
            <Progress value={trafficProgress} className="h-2" />
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          {isActive && (
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => onShowQR(subscription)}
            >
              <QrCode className="mr-2 h-4 w-4" />
              QR код
            </Button>
          )}
          <Button
            variant={isActive ? "default" : "outline"}
            size="sm"
            className="flex-1"
            onClick={() => onRenew(subscription)}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {isActive ? 'Продлить' : 'Возобновить'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

import { cn } from '@/lib/utils';

export default SubscriptionCard;
