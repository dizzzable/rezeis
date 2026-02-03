import { useState } from 'react';
import { Wallet, Clock, CheckCircle, XCircle, AlertCircle, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface PartnerPayoutItem {
  id: string;
  amount: number;
  method: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  transactionId?: string;
  notes?: string;
  createdAt: string;
  processedAt?: string;
}

interface PartnerPayoutsTableProps {
  payouts: PartnerPayoutItem[];
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
 * Get status config
 */
function getStatusConfig(status: string): {
  label: string;
  icon: React.ReactNode;
  className: string;
} {
  switch (status) {
    case 'pending':
      return {
        label: 'Ожидает',
        icon: <Clock className="h-4 w-4" />,
        className: 'bg-yellow-100 text-yellow-800',
      };
    case 'processing':
      return {
        label: 'В обработке',
        icon: <Clock className="h-4 w-4" />,
        className: 'bg-blue-100 text-blue-800',
      };
    case 'completed':
      return {
        label: 'Выполнено',
        icon: <CheckCircle className="h-4 w-4" />,
        className: 'bg-green-100 text-green-800',
      };
    case 'failed':
      return {
        label: 'Ошибка',
        icon: <XCircle className="h-4 w-4" />,
        className: 'bg-red-100 text-red-800',
      };
    case 'cancelled':
      return {
        label: 'Отменено',
        icon: <AlertCircle className="h-4 w-4" />,
        className: 'bg-gray-100 text-gray-800',
      };
    default:
      return {
        label: status,
        icon: <AlertCircle className="h-4 w-4" />,
        className: 'bg-gray-100 text-gray-800',
      };
  }
}

/**
 * Get method label
 */
function getMethodLabel(method: string): string {
  const labels: Record<string, string> = {
    bank_transfer: 'Банковский перевод',
    paypal: 'PayPal',
    crypto: 'Криптовалюта',
    other: 'Другое',
  };
  return labels[method] || method;
}

/**
 * PartnerPayoutsTable component
 * Displays partner payouts history
 */
export function PartnerPayoutsTable({
  payouts,
  isLoading,
  className,
}: PartnerPayoutsTableProps): React.ReactElement {
  const [filterStatus, setFilterStatus] = useState<string>('all');

  const filteredPayouts = payouts.filter((item) => {
    if (filterStatus !== 'all' && item.status !== filterStatus) return false;
    return true;
  });

  const totalPending = payouts
    .filter((p) => p.status === 'pending')
    .reduce((sum, p) => sum + p.amount, 0);

  const totalCompleted = payouts
    .filter((p) => p.status === 'completed')
    .reduce((sum, p) => sum + p.amount, 0);

  const handleExport = (): void => {
    const csv = [
      ['Дата запроса', 'Сумма', 'Способ', 'Статус', 'Дата обработки', 'Transaction ID'].join(','),
      ...filteredPayouts.map((item) =>
        [
          formatDate(item.createdAt),
          item.amount,
          getMethodLabel(item.method),
          item.status,
          item.processedAt ? formatDate(item.processedAt) : '-',
          item.transactionId || '-',
        ].join(',')
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'partner-payouts.csv';
    link.click();
  };

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Wallet className="h-5 w-5" />
              История выплат
            </CardTitle>
            <div className="flex gap-4 text-sm text-muted-foreground mt-1">
              <span>
                Ожидает: <span className="font-medium text-yellow-600">{formatCurrency(totalPending)}</span>
              </span>
              <span>
                Выплачено: <span className="font-medium text-green-600">{formatCurrency(totalCompleted)}</span>
              </span>
            </div>
          </div>
          <Button variant="outline" size="icon" onClick={handleExport}>
            <Download className="h-4 w-4" />
          </Button>
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-1 mt-2">
          {['all', 'pending', 'processing', 'completed', 'failed'].map((status) => (
            <Button
              key={status}
              variant={filterStatus === status ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilterStatus(status)}
              className="text-xs"
            >
              {status === 'all' && 'Все'}
              {status === 'pending' && 'Ожидают'}
              {status === 'processing' && 'В обработке'}
              {status === 'completed' && 'Выполнены'}
              {status === 'failed' && 'Ошибки'}
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
        ) : filteredPayouts.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            Нет записей для отображения
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Дата запроса</TableHead>
                  <TableHead className="text-right">Сумма</TableHead>
                  <TableHead>Способ</TableHead>
                  <TableHead className="text-center">Статус</TableHead>
                  <TableHead>Дата обработки</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPayouts.map((item) => {
                  const status = getStatusConfig(item.status);
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="text-sm">
                        {formatDate(item.createdAt)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(item.amount)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {getMethodLabel(item.method)}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge className={cn('text-xs flex items-center gap-1 mx-auto w-fit', status.className)}>
                          {status.icon}
                          {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {item.processedAt ? formatDate(item.processedAt) : '-'}
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

export default PartnerPayoutsTable;
