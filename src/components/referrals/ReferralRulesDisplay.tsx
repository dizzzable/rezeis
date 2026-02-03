import { Gift, Info, CheckCircle, Clock, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

interface ReferralRule {
  id: string;
  name: string;
  description: string;
  type: 'first_purchase' | 'cumulative' | 'subscription';
  referrerReward: number;
  referredReward: number;
  minPurchaseAmount?: number;
  appliesToPlans?: string[];
  isActive: boolean;
  startDate?: string;
  endDate?: string;
}

interface ReferralRulesDisplayProps {
  rules: ReferralRule[];
  className?: string;
}

/**
 * Get rule type label
 */
function getTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    first_purchase: 'Первая покупка',
    cumulative: 'Накопительная',
    subscription: 'Подписка',
  };
  return labels[type] || type;
}

/**
 * Get rule type color
 */
function getTypeColor(type: string): string {
  const colors: Record<string, string> = {
    first_purchase: 'bg-blue-100 text-blue-800',
    cumulative: 'bg-green-100 text-green-800',
    subscription: 'bg-purple-100 text-purple-800',
  };
  return colors[type] || 'bg-gray-100 text-gray-800';
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
 * Check if rule is active
 */
function isRuleActive(rule: ReferralRule): boolean {
  if (!rule.isActive) return false;
  const now = new Date();
  if (rule.startDate && new Date(rule.startDate) > now) return false;
  if (rule.endDate && new Date(rule.endDate) < now) return false;
  return true;
}

/**
 * ReferralRulesDisplay component
 * Displays referral program rules in a visual format
 */
export function ReferralRulesDisplay({ rules, className }: ReferralRulesDisplayProps): React.ReactElement {
  const activeRules = rules.filter(isRuleActive);
  const inactiveRules = rules.filter((r) => !isRuleActive(r));

  return (
    <div className={cn('space-y-6', className)}>
      {/* Info Alert */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          Приглашайте друзей и получайте вознаграждение! Чем больше друзей вы пригласите, 
          тем больше бонусов получите.
        </AlertDescription>
      </Alert>

      {/* How it works */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5" />
            Как это работает
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex flex-col items-center text-center p-4 rounded-lg bg-muted">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                <span className="text-lg font-bold text-primary">1</span>
              </div>
              <h4 className="font-medium mb-1">Поделитесь ссылкой</h4>
              <p className="text-sm text-muted-foreground">
                Отправьте реферальную ссылку друзьям
              </p>
            </div>
            <div className="flex flex-col items-center text-center p-4 rounded-lg bg-muted">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                <span className="text-lg font-bold text-primary">2</span>
              </div>
              <h4 className="font-medium mb-1">Друг регистрируется</h4>
              <p className="text-sm text-muted-foreground">
                Друг переходит по ссылке и создает аккаунт
              </p>
            </div>
            <div className="flex flex-col items-center text-center p-4 rounded-lg bg-muted">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                <span className="text-lg font-bold text-primary">3</span>
              </div>
              <h4 className="font-medium mb-1">Получите награду</h4>
              <p className="text-sm text-muted-foreground">
                Зарабатывайте на покупках друзей
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Active Rules */}
      {activeRules.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-green-500" />
            Активные правила
          </h3>
          <div className="grid gap-4 md:grid-cols-2">
            {activeRules.map((rule) => (
              <Card key={rule.id} className="border-green-200">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-base">{rule.name}</CardTitle>
                      <CardDescription>{rule.description}</CardDescription>
                    </div>
                    <Badge className={getTypeColor(rule.type)}>
                      {getTypeLabel(rule.type)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-3 rounded-lg bg-green-50">
                      <div className="text-sm text-muted-foreground mb-1">Вы получите</div>
                      <div className="text-xl font-bold text-green-600">
                        {formatCurrency(rule.referrerReward)}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-blue-50">
                      <div className="text-sm text-muted-foreground mb-1">Друг получит</div>
                      <div className="text-xl font-bold text-blue-600">
                        {formatCurrency(rule.referredReward)}
                      </div>
                    </div>
                  </div>
                  {rule.minPurchaseAmount && (
                    <div className="text-sm text-muted-foreground">
                      Минимальная сумма покупки: {formatCurrency(rule.minPurchaseAmount)}
                    </div>
                  )}
                  {rule.endDate && (
                    <div className="flex items-center gap-1 text-sm text-orange-600">
                      <Clock className="h-4 w-4" />
                      До {new Date(rule.endDate).toLocaleDateString('ru-RU')}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Inactive Rules */}
      {inactiveRules.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-gray-400" />
            Неактивные правила
          </h3>
          <div className="grid gap-4 md:grid-cols-2 opacity-60">
            {inactiveRules.map((rule) => (
              <Card key={rule.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-base">{rule.name}</CardTitle>
                      <CardDescription>{rule.description}</CardDescription>
                    </div>
                    <Badge variant="secondary">{getTypeLabel(rule.type)}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-sm text-muted-foreground">Вы получите</div>
                      <div className="text-lg font-medium">{formatCurrency(rule.referrerReward)}</div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground">Друг получит</div>
                      <div className="text-lg font-medium">{formatCurrency(rule.referredReward)}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ReferralRulesDisplay;
