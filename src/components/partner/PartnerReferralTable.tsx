import { useState } from 'react';
import { Users, Search, Crown, Award, Star } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface PartnerReferralDetail {
  id: string;
  referredUserId: string;
  level: number;
  status: 'active' | 'converted' | 'inactive';
  clicks: number;
  conversions: number;
  totalEarnings: number;
  firstClickAt?: string;
  convertedAt?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
  subscriptionCount: number;
}

interface PartnerReferralTableProps {
  referrals: PartnerReferralDetail[];
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
 * Format date
 */
function formatDate(dateString?: string): string {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Get level icon
 */
function getLevelIcon(level: number): React.ReactNode {
  switch (level) {
    case 1:
      return <Crown className="h-4 w-4 text-yellow-500" />;
    case 2:
      return <Award className="h-4 w-4 text-blue-500" />;
    case 3:
      return <Star className="h-4 w-4 text-green-500" />;
    default:
      return <Users className="h-4 w-4 text-gray-500" />;
  }
}

/**
 * Get status badge
 */
function getStatusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case 'active':
      return { label: 'Активен', className: 'bg-blue-100 text-blue-800' };
    case 'converted':
      return { label: 'Конвертирован', className: 'bg-green-100 text-green-800' };
    case 'inactive':
      return { label: 'Неактивен', className: 'bg-gray-100 text-gray-800' };
    default:
      return { label: status, className: 'bg-gray-100 text-gray-800' };
  }
}

/**
 * PartnerReferralTable component
 * Displays partner referrals with search and filtering
 */
export function PartnerReferralTable({
  referrals,
  isLoading,
  className,
}: PartnerReferralTableProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterLevel, setFilterLevel] = useState<number | 'all'>('all');
  const [filterStatus] = useState<string>('all');

  const filteredReferrals = referrals.filter((item) => {
    if (filterLevel !== 'all' && item.level !== filterLevel) return false;
    if (filterStatus !== 'all' && item.status !== filterStatus) return false;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const name = (item.firstName || item.username || '').toLowerCase();
      if (!name.includes(query)) return false;
    }
    return true;
  });

  // Calculate stats by level
  const statsByLevel = referrals.reduce(
    (acc, ref) => {
      acc[ref.level] = (acc[ref.level] || 0) + 1;
      return acc;
    },
    {} as Record<number, number>
  );

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Users className="h-5 w-5" />
              Мои рефералы
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Всего: <span className="font-medium">{referrals.length}</span> рефералов
              {statsByLevel[1] && ` • ${statsByLevel[1]} прямых`}
              {statsByLevel[2] && ` • ${statsByLevel[2]} 2-го ур.`}
              {statsByLevel[3] && ` • ${statsByLevel[3]} 3-го ур.`}
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 mt-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Поиск по имени..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex gap-1">
            <Button
              variant={filterLevel === 'all' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilterLevel('all')}
              className="text-xs"
            >
              Все уровни
            </Button>
            {[1, 2, 3].map((level) => (
              <Button
                key={level}
                variant={filterLevel === level ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setFilterLevel(level)}
                className="text-xs px-2"
              >
                {getLevelIcon(level)}
                <span className="ml-1">{level}</span>
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-14 bg-muted rounded animate-pulse" />
            ))}
          </div>
        ) : filteredReferrals.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            Нет рефералов для отображения
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Реферал</TableHead>
                  <TableHead className="text-center">Ур.</TableHead>
                  <TableHead className="text-center">Статус</TableHead>
                  <TableHead className="text-center">Клики</TableHead>
                  <TableHead className="text-center">Продажи</TableHead>
                  <TableHead className="text-right">Доход</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredReferrals.map((item) => {
                  const status = getStatusBadge(item.status);
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarImage src={item.photoUrl} />
                            <AvatarFallback className="text-xs">
                              {(item.firstName?.[0] || item.username?.[0] || '?').toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-medium">
                              {item.firstName || item.username || 'Unknown'}
                            </div>
                            {item.convertedAt && (
                              <div className="text-xs text-muted-foreground">
                                С {formatDate(item.convertedAt)}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          {getLevelIcon(item.level)}
                          <span className="text-sm">{item.level}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge className={cn('text-xs', status.className)}>
                          {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">{item.clicks}</TableCell>
                      <TableCell className="text-center">{item.conversions}</TableCell>
                      <TableCell className="text-right font-medium text-green-600">
                        {formatCurrency(item.totalEarnings)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default PartnerReferralTable;
