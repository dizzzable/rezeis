import { useState } from 'react';
import { ArrowUpDown, Calendar, Filter, Download, Star } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface ReferralEarning {
  id: string;
  points: number;
  type: 'direct' | 'level2' | 'level3' | 'bonus';
  level: number;
  description?: string;
  source: 'registration' | 'purchase' | 'subscription' | 'bonus';
  createdAt: string;
  referredUsername?: string;
  referredFirstName?: string;
}

interface ReferralHistoryTableProps {
  history: ReferralEarning[];
  isLoading: boolean;
  className?: string;
}

type SortField = 'date' | 'points' | 'level';
type SortOrder = 'asc' | 'desc';

/**
 * Format points
 */
function formatPoints(amount: number): string {
  return new Intl.NumberFormat('ru-RU').format(amount);
}

/**
 * Format date
 */
function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Get type label
 */
function getTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    direct: 'Прямой',
    level2: '2-й уровень',
    level3: '3-й уровень',
    bonus: 'Бонус',
  };
  return labels[type] || type;
}

/**
 * Get source label
 */
function getSourceLabel(source: string): string {
  const labels: Record<string, string> = {
    registration: 'Регистрация',
    purchase: 'Покупка',
    subscription: 'Подписка',
    bonus: 'Бонус',
  };
  return labels[source] || source;
}

/**
 * ReferralHistoryTable component
 * Displays referral points history with filtering and sorting
 */
export function ReferralHistoryTable({ history, isLoading, className }: ReferralHistoryTableProps): React.ReactElement {
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [filterType, setFilterType] = useState<string>('all');

  const handleSort = (field: SortField): void => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  // Filter and sort history
  const filteredHistory = history
    .filter((item) => {
      if (filterType !== 'all' && item.type !== filterType) return false;
      return true;
    })
    .sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'date':
          comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case 'points':
          comparison = a.points - b.points;
          break;
        case 'level':
          comparison = a.level - b.level;
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

  const totalPoints = filteredHistory.reduce((sum, item) => sum + item.points, 0);

  const handleExport = (): void => {
    const csv = [
      ['Дата', 'Тип', 'Уровень', 'От кого', 'Баллы', 'Источник'].join(','),
      ...filteredHistory.map((item) =>
        [
          formatDate(item.createdAt),
          getTypeLabel(item.type),
          item.level,
          item.referredFirstName || item.referredUsername || 'Unknown',
          item.points,
          getSourceLabel(item.source),
        ].join(',')
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'referral-history.csv';
    link.click();
  };

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg">История начислений баллов</CardTitle>
            <p className="text-sm text-muted-foreground">
              Всего получено: <span className="font-medium text-green-600">{formatPoints(totalPoints)} баллов</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <SelectTrigger className="w-[140px]">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Тип" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все типы</SelectItem>
                <SelectItem value="direct">Прямой</SelectItem>
                <SelectItem value="level2">2-й уровень</SelectItem>
                <SelectItem value="level3">3-й уровень</SelectItem>
                <SelectItem value="bonus">Бонус</SelectItem>
              </SelectContent>
            </Select>

            <Button variant="outline" size="icon" onClick={handleExport}>
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-12 w-full bg-muted animate-pulse rounded" />
            ))}
          </div>
        ) : filteredHistory.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            Нет записей для отображения
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Button variant="ghost" size="sm" onClick={() => handleSort('date')}>
                      <Calendar className="h-4 w-4 mr-1" />
                      Дата
                      <ArrowUpDown className="h-3 w-3 ml-1" />
                    </Button>
                  </TableHead>
                  <TableHead>Тип</TableHead>
                  <TableHead>Ур.</TableHead>
                  <TableHead>От кого</TableHead>
                  <TableHead>
                    <Button variant="ghost" size="sm" onClick={() => handleSort('points')}>
                      <Star className="h-4 w-4 mr-1" />
                      Баллы
                      <ArrowUpDown className="h-3 w-3 ml-1" />
                    </Button>
                  </TableHead>
                  <TableHead>Источник</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredHistory.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="text-sm">
                      {formatDate(item.createdAt)}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{getTypeLabel(item.type)}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{item.level}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">
                        {item.referredFirstName || item.referredUsername || 'Unknown'}
                      </span>
                    </TableCell>
                    <TableCell className={cn('font-medium text-green-600')}>
                      +{formatPoints(item.points)}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {getSourceLabel(item.source)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ReferralHistoryTable;
