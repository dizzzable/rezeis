import { useState } from 'react';
import { DollarSign, Download, Calendar } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface PartnerEarningItem {
  id: string;
  amount: number;
  commissionRate: number;
  status: 'pending' | 'approved' | 'paid' | 'cancelled';
  createdAt: string;
  paidAt?: string;
  referredUsername?: string;
  referredFirstName?: string;
  planName?: string;
}

interface PartnerEarningsTableProps {
  earnings: PartnerEarningItem[];
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
function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Get status badge
 */
function getStatusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case 'paid':
      return { label: 'Выплачено', className: 'bg-green-100 text-green-800' };
    case 'approved':
      return { label: 'Подтверждено', className: 'bg-blue-100 text-blue-800' };
    case 'pending':
      return { label: 'Ожидает', className: 'bg-yellow-100 text-yellow-800' };
    case 'cancelled':
      return { label: 'Отменено', className: 'bg-red-100 text-red-800' };
    default:
      return { label: status, className: 'bg-gray-100 text-gray-800' };
  }
}

/**
 * PartnerEarningsTable component
 * Displays partner earnings history with filtering
 */
export function PartnerEarningsTable({
  earnings,
  isLoading,
  className,
}: PartnerEarningsTableProps): React.ReactElement {
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredEarnings = earnings.filter((item) => {
    if (filterStatus !== 'all' && item.status !== filterStatus) return false;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const name = (item.referredFirstName || item.referredUsername || '').toLowerCase();
      if (!name.includes(query)) return false;
    }
    return true;
  });

  const totalAmount = filteredEarnings.reduce((sum, item) => sum + item.amount, 0);

  const handleExport = (): void => {
    const csv = [
      ['Дата', 'От кого', 'План', 'Сумма', 'Комиссия', 'Статус'].join(','),
      ...filteredEarnings.map((item) =>
        [
          formatDate(item.createdAt),
          item.referredFirstName || item.referredUsername || 'Unknown',
          item.planName || '-',
          item.amount,
          item.commissionRate + '%',
          item.status,
        ].join(',')
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'partner-earnings.csv';
    link.click();
  };

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <DollarSign className="h-5 w-5" />
              История начислений
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Всего: <span className="font-medium text-green-600">{formatCurrency(totalAmount)}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Поиск по имени..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-[200px]"
            />
            <Button variant="outline" size="icon" onClick={handleExport}>
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-1 mt-2">
          {['all', 'pending', 'approved', 'paid'].map((status) => (
            <Button
              key={status}
              variant={filterStatus === status ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilterStatus(status)}
              className="text-xs"
            >
              {status === 'all' && 'Все'}
              {status === 'pending' && 'Ожидают'}
              {status === 'approved' && 'Подтверждены'}
              {status === 'paid' && 'Выплачены'}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-12 bg-muted rounded animate-pulse" />
            ))}
          </div>
        ) : filteredEarnings.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            Нет записей для отображения
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Дата</TableHead>
                  <TableHead>От кого</TableHead>
                  <TableHead>План</TableHead>
                  <TableHead className="text-right">Сумма</TableHead>
                  <TableHead className="text-center">Комиссия</TableHead>
                  <TableHead className="text-center">Статус</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredEarnings.map((item) => {
                  const status = getStatusBadge(item.status);
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="text-sm">
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3 text-muted-foreground" />
                          {formatDate(item.createdAt)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">
                          {item.referredFirstName || item.referredUsername || 'Unknown'}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {item.planName || '-'}
                      </TableCell>
                      <TableCell className="text-right font-medium text-green-600">
                        +{formatCurrency(item.amount)}
                      </TableCell>
                      <TableCell className="text-center text-sm">
                        {item.commissionRate}%
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge className={cn('text-xs', status.className)}>
                          {status.label}
                        </Badge>
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

export default PartnerEarningsTable;
